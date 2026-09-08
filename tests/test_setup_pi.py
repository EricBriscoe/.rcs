import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]


class PiSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi setup test ")
        self.addCleanup(self.temp.cleanup)
        self.agent_dir = Path(self.temp.name) / "agent"
        self.agent_dir.mkdir()
        self.settings = self.agent_dir / "settings.json"
        self.instructions = self.agent_dir / "AGENTS.md"
        self.web_extension = self.agent_dir / "extensions/web"
        self.ask_extension = self.agent_dir / "extensions/ask-user"
        self.monitor_extension = self.agent_dir / "extensions/monitor"
        self.memory_extension = self.agent_dir / "extensions/memory"
        self.project_extension = self.agent_dir / "extensions/project-context"
        self.navigation_extension = self.agent_dir / "extensions/code-navigation"
        self.efficiency_extension = self.agent_dir / "extensions/efficiency"
        self.launcher = self.agent_dir / "bin/pi"
        self.env = dict(os.environ, PI_CODING_AGENT_DIR=str(self.agent_dir), HOME=self.temp.name, PI_AUTO_UPDATE="1")

    def run_setup(self, *args):
        return subprocess.run(
            ["/bin/bash", str(REPO / "setup-pi.sh"), *args],
            env=self.env, cwd=REPO, capture_output=True, text=True, check=True,
        )

    def stub_install_commands(self, npm_exit=0, browser_exit=0):
        fake_bin = Path(self.temp.name) / "bin"
        fake_bin.mkdir()
        self.install_log = Path(self.temp.name) / "install.log"
        scripts = {
            "node": (
                'if [ "$1" = "-p" ]; then printf "%s\\n" "$PI_SETUP_SUBAGENT_PIN"; fi\n'
                'if [ "$2" = "install" ]; then printf "%s\\n" pi "$2" "$3" '
                '"npm_config_ignore_scripts=${npm_config_ignore_scripts:-}" >> "$PI_SETUP_TEST_LOG"; fi\n'
                'if [ "${1##*/}" = "update-deps.mjs" ]; then printf "%s\\n" update-deps >> "$PI_SETUP_TEST_LOG"; fi\n'
                'if [ "${1##*/}" = "install-memory-embedding.mjs" ]; then printf "%s\\n" memory-embedding >> "$PI_SETUP_TEST_LOG"; fi\n'
                'exit 0\n'
            ),
            "npm": (
                'printf "%s\\n" npm "$@" >> "$PI_SETUP_TEST_LOG"\n'
                f"exit {npm_exit}\n"
            ),
            "playwright-cli": (
                'printf "%s\\n" playwright-cli "$@" '
                '"PLAYWRIGHT_SKIP_BROWSER_GC=${PLAYWRIGHT_SKIP_BROWSER_GC:-}" '
                '>> "$PI_SETUP_TEST_LOG"\n'
                f"exit {browser_exit}\n"
            ),
        }
        for name, script in scripts.items():
            executable = fake_bin / name
            executable.write_text("#!/bin/sh\n" + script)
            executable.chmod(0o755)
        self.env["PATH"] = f"{fake_bin}:{self.env['PATH']}"
        self.env["PI_SETUP_TEST_LOG"] = str(self.install_log)
        self.env["PI_SETUP_SUBAGENT_PIN"] = json.loads((REPO / "pi/settings.json").read_text())["packages"][0]
        self.env.pop("PLAYWRIGHT_SKIP_BROWSER_GC", None)

    def assert_resource_links(self):
        for link, source in (
            (self.settings, REPO / "pi/settings.json"),
            (self.agent_dir / "models.json", REPO / "pi/models.json"),
            (self.instructions, REPO / "pi/AGENTS.md"),
            (self.web_extension, REPO / "pi/extensions/web"),
            (self.ask_extension, REPO / "pi/extensions/ask-user"),
            (self.monitor_extension, REPO / "pi/extensions/monitor"),
            (self.memory_extension, REPO / "pi/extensions/memory"),
            (self.project_extension, REPO / "pi/extensions/project-context"),
            (self.navigation_extension, REPO / "pi/extensions/code-navigation"),
            (self.efficiency_extension, REPO / "pi/extensions/efficiency"),
            (self.agent_dir / "extensions/appearance", REPO / "pi/extensions/appearance"),
            (self.agent_dir / "themes/quiet-graphite.json", REPO / "pi/themes/quiet-graphite.json"),
            (self.agent_dir / "themes/paper.json", REPO / "pi/themes/paper.json"),
            (self.launcher, REPO / "pi/launch.mjs"),
            (self.agent_dir / "bin/rtk", REPO / "pi/rtk.mjs"),
            (Path(self.temp.name) / ".local/bin/rtk", REPO / "pi/rtk.mjs"),
        ):
            with self.subTest(link=link):
                self.assertTrue(link.is_symlink())
                self.assertTrue(link.exists())
                self.assertEqual(link.resolve(), source)

    def test_fresh_install_and_rerun_preserve_local_state(self):
        auth = self.agent_dir / "auth.json"
        auth.write_text('{"test": "local credential fixture"}\n')
        auth.chmod(0o600)
        sessions = self.agent_dir / "sessions"
        sessions.mkdir()
        session = sessions / "test.jsonl"
        session.write_text("local session fixture\n")
        memory = self.agent_dir / "memory/memory.sqlite"
        memory.parent.mkdir(mode=0o700)
        memory.write_bytes(b"local memory fixture")
        memory.chmod(0o600)
        unrelated_extension = self.agent_dir / "extensions/other.ts"
        unrelated_extension.parent.mkdir()
        unrelated_extension.write_text("// Local extension fixture\n")
        unrelated_skill = self.agent_dir / "skills/other/SKILL.md"
        unrelated_skill.parent.mkdir(parents=True)
        unrelated_skill.write_text("Local skill fixture\n")

        self.run_setup("--skip-install")
        self.assert_resource_links()
        links = (
            self.settings, self.instructions, self.web_extension,
            self.ask_extension, self.monitor_extension, self.memory_extension,
            self.project_extension,
            self.navigation_extension, self.efficiency_extension, self.launcher,
        )
        link_inodes = [link.lstat().st_ino for link in links]
        self.run_setup("--skip-install")

        self.assert_resource_links()
        self.assertEqual([link.lstat().st_ino for link in links], link_inodes)
        self.assertEqual(list(self.agent_dir.glob("*-backup.*")), [])
        self.assertEqual(auth.read_text(), '{"test": "local credential fixture"}\n')
        self.assertEqual(auth.stat().st_mode & 0o777, 0o600)
        self.assertEqual(session.read_text(), "local session fixture\n")
        self.assertEqual(memory.read_bytes(), b"local memory fixture")
        self.assertEqual(memory.stat().st_mode & 0o777, 0o600)
        self.assertEqual(unrelated_extension.read_text(), "// Local extension fixture\n")
        self.assertEqual(unrelated_skill.read_text(), "Local skill fixture\n")

    def test_owned_themes_preserve_siblings_back_up_conflicts_and_relink_idempotently(self):
        themes = self.agent_dir / "themes"
        themes.mkdir()
        unrelated = themes / "my-theme.json"
        unrelated.write_text('{"name":"my-theme"}\n')
        paper = themes / "paper.json"
        paper.write_text('{"name":"previous-paper"}\n')
        self.run_setup("--skip-install")
        inode = paper.lstat().st_ino
        self.run_setup("--skip-install")
        self.assert_resource_links()
        self.assertEqual(paper.lstat().st_ino, inode)
        self.assertEqual(unrelated.read_text(), '{"name":"my-theme"}\n')
        backups = list(self.agent_dir.glob("theme-backup.*/paper.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), '{"name":"previous-paper"}\n')

    def test_prefixed_links_migrate_without_duplicate_extensions(self):
        extensions = self.agent_dir / "extensions"
        extensions.mkdir()
        for source in (REPO / "pi/extensions").iterdir():
            if (source / "index.ts").is_file():
                (extensions / f"rcs-{source.name}").symlink_to(source)
        self.run_setup("--skip-install")
        self.run_setup("--skip-install")
        self.assert_resource_links()
        self.assertEqual(list(extensions.glob("rcs-*")), [])

    def test_prefixed_user_replacements_are_preserved(self):
        extensions = self.agent_dir / "extensions"
        old_directory = extensions / "rcs-memory"
        old_directory.mkdir(parents=True)
        (old_directory / "index.ts").write_text("// User replacement\n")
        other = Path(self.temp.name) / "user-extension"
        other.mkdir()
        old_link = extensions / "rcs-web"
        old_link.symlink_to(other)
        self.run_setup("--skip-install")
        self.assert_resource_links()
        self.assertEqual((old_directory / "index.ts").read_text(), "// User replacement\n")
        self.assertEqual(old_link.resolve(), other.resolve())

    def test_existing_settings_are_backed_up_once(self):
        previous = '{"defaultProvider": "another-provider"}\n'
        self.settings.write_text(previous)
        self.run_setup("--skip-install")
        self.run_setup("--skip-install")

        backups = list(self.agent_dir.glob("settings-backup.*/settings.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), previous)
        self.assertEqual(self.settings.resolve(), REPO / "pi/settings.json")

    def test_astra_compaction_budget_is_model_specific(self):
        models = json.loads((REPO / "pi/models.json").read_text())
        self.assertEqual(models, {"providers": {"openai-codex": {"modelOverrides": {
            "gpt-6-astra": {"contextWindow": 416384},
        }}}})
        settings = json.loads((REPO / "pi/settings.json").read_text())
        reserve = settings.get("compaction", {}).get("reserveTokens", 16384)
        self.assertEqual(416384 - reserve, 400000)

    def test_existing_models_are_backed_up_once(self):
        models = self.agent_dir / "models.json"
        previous = '{"providers": {"local-fixture": {"models": [{"id": "local"}]}}}\n'
        models.write_text(previous)
        self.run_setup("--skip-install")
        inode = models.lstat().st_ino
        self.run_setup("--skip-install")
        backups = list(self.agent_dir.glob("models-backup.*/models.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), previous)
        self.assertEqual(models.resolve(), REPO / "pi/models.json")
        self.assertEqual(models.lstat().st_ino, inode)

    def test_existing_symlink_target_is_untouched(self):
        other = Path(self.temp.name) / "other.json"
        other.write_text('{"theme": "light"}\n')
        self.settings.symlink_to(other)
        self.run_setup("--skip-install")

        backup = next(self.agent_dir.glob("settings-backup.*/settings.json"))
        self.assertTrue(backup.is_symlink())
        self.assertEqual(backup.resolve(), other.resolve())
        self.assertEqual(other.read_text(), '{"theme": "light"}\n')

    def test_existing_instructions_and_extension_are_backed_up_once(self):
        previous_instructions = "Local instruction fixture\n"
        self.instructions.write_text(previous_instructions)
        self.web_extension.mkdir(parents=True)
        (self.web_extension / "index.ts").write_text("// Previous extension fixture\n")

        self.run_setup("--skip-install")
        self.run_setup("--skip-install")

        instructions = list(self.agent_dir.glob("instructions-backup.*/AGENTS.md"))
        extensions = list(self.agent_dir.glob("extension-backup.*/web/index.ts"))
        self.assertEqual(len(instructions), 1)
        self.assertEqual(instructions[0].read_text(), previous_instructions)
        self.assertEqual(len(extensions), 1)
        self.assertEqual(extensions[0].read_text(), "// Previous extension fixture\n")
        self.assert_resource_links()

    def test_existing_memory_extension_is_backed_up_once(self):
        self.memory_extension.mkdir(parents=True)
        (self.memory_extension / "index.ts").write_text("// Previous memory extension\n")
        self.run_setup("--skip-install")
        self.run_setup("--skip-install")
        backups = list(self.agent_dir.glob("extension-backup.*/memory/index.ts"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "// Previous memory extension\n")
        self.assert_resource_links()

    def test_skills_use_standard_discovery_and_back_up_replacements(self):
        skill = self.agent_dir / "skills/schlep"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("User-owned replacement\n")
        self.run_setup("--skip-install")
        self.run_setup("--skip-install")
        self.assertEqual(skill.resolve(), REPO / "pi/skills/schlep")
        self.assertEqual((self.agent_dir / "skills/pi-maintenance").resolve(), REPO / "pi/skills/pi-maintenance")
        backups = list(self.agent_dir.glob("skill-backup.*/schlep/SKILL.md"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "User-owned replacement\n")

    def test_retired_runtime_links_removed_but_data_and_user_replacements_survive(self):
        extensions = self.agent_dir / "extensions"
        extensions.mkdir()
        for name in ["orchestrate", "rcs-orchestrate"]:
            (extensions / name).symlink_to(REPO / "pi/extensions/orchestrate")
        state = self.agent_dir / "orchestrator/tasks.sqlite"
        state.parent.mkdir()
        state.write_bytes(b"historical task fixture")
        self.run_setup("--skip-install")
        for name in ["orchestrate", "rcs-orchestrate"]:
            self.assertFalse((extensions / name).is_symlink())
        self.assertEqual(state.read_bytes(), b"historical task fixture")
        replacement = extensions / "orchestrate"
        replacement.mkdir()
        (replacement / "index.ts").write_text("// user replacement")
        self.run_setup("--skip-install")
        self.assertEqual((replacement / "index.ts").read_text(), "// user replacement")

    def test_existing_launcher_is_backed_up_once(self):
        self.launcher.parent.mkdir()
        self.launcher.write_text("previous launcher\n")
        self.run_setup("--skip-install")
        self.run_setup("--skip-install")
        backups = list(self.agent_dir.glob("launcher-backup.*/pi"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "previous launcher\n")

    def test_relative_extension_symlink_backup_keeps_its_target(self):
        self.env["PI_CODING_AGENT_DIR"] = os.path.relpath(self.agent_dir, REPO)
        original = Path(self.temp.name) / "local-web"
        original.mkdir()
        (original / "index.ts").write_text("// Original local extension\n")
        self.web_extension.parent.mkdir()
        self.web_extension.symlink_to("../../local-web")

        self.run_setup("--skip-install")

        backup = next(self.agent_dir.glob("extension-backup.*/web"))
        self.assertTrue(backup.is_symlink())
        self.assertEqual(backup.resolve(), original.resolve())
        self.assertEqual((backup / "index.ts").read_text(), "// Original local extension\n")
        self.assert_resource_links()

    def test_full_install_uses_latest_and_preserves_browser_cache(self):
        self.stub_install_commands()
        self.run_setup()

        pi_version = playwright_version = "latest"
        self.assertEqual(self.install_log.read_text().splitlines(), [
            "npm", "install", "-g", "--ignore-scripts",
            f"@earendil-works/pi-coding-agent@{pi_version}",
            f"@playwright/cli@{playwright_version}",
            "playwright-cli", "install-browser", "chromium",
            "PLAYWRIGHT_SKIP_BROWSER_GC=1",
            "memory-embedding",
            "npm", "ci", "--ignore-scripts", "--omit=dev", "--prefix",
            str(REPO / "pi/extensions/codex-account-pool"),
            "pi", "install", self.env["PI_SETUP_SUBAGENT_PIN"],
            "npm_config_ignore_scripts=true",
            "update-deps",
        ])
        self.assert_resource_links()

    def test_update_bypass_uses_bootstrap_versions_without_updater(self):
        self.stub_install_commands()
        self.env["PI_AUTO_UPDATE"] = "0"
        self.run_setup()
        log = self.install_log.read_text().splitlines()
        self.assertIn("@earendil-works/pi-coding-agent@" + (REPO / "pi/version").read_text().strip(), log)
        self.assertIn("@playwright/cli@" + (REPO / "pi/playwright-version").read_text().strip(), log)
        self.assertNotIn("update-deps", log)
        self.assertIn("memory-embedding", log)

    def test_skip_install_never_downloads_embedding_runtime(self):
        self.stub_install_commands()
        self.run_setup("--skip-install")
        self.assertFalse(self.install_log.exists())
        self.assertFalse((self.agent_dir / "tooling/memory-embedding").exists())

    def test_rtk_launcher_conflict_is_backed_up_and_reruns_are_idempotent(self):
        target = Path(self.temp.name) / ".local/bin/rtk"
        target.parent.mkdir(parents=True)
        target.write_text("user launcher\n")
        self.run_setup("--skip-install")
        backups = list(self.agent_dir.glob("launcher-backup.*/rtk"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "user launcher\n")
        inode = target.lstat().st_ino
        self.run_setup("--skip-install")
        self.assertEqual(target.lstat().st_ino, inode)

    def test_failed_package_install_leaves_settings_untouched(self):
        self.stub_install_commands(npm_exit=42)
        self.settings.write_text("{}\n")

        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.run_setup()
        self.assertEqual(failure.exception.returncode, 42)
        self.assertFalse(self.settings.is_symlink())
        self.assertEqual(self.settings.read_text(), "{}\n")
        self.assertEqual(list(self.agent_dir.glob("*-backup.*")), [])
        self.assertFalse(self.instructions.exists())
        self.assertFalse(self.web_extension.exists())
        self.assertNotIn("playwright-cli", self.install_log.read_text().splitlines())

    def test_failed_browser_install_leaves_existing_resources_untouched(self):
        self.stub_install_commands(browser_exit=43)
        self.settings.write_text("{}\n")
        self.instructions.write_text("Local instruction fixture\n")

        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.run_setup()

        self.assertEqual(failure.exception.returncode, 43)
        self.assertFalse(self.settings.is_symlink())
        self.assertFalse(self.instructions.is_symlink())
        self.assertEqual(self.settings.read_text(), "{}\n")
        self.assertEqual(self.instructions.read_text(), "Local instruction fixture\n")
        self.assertFalse(self.web_extension.exists())
        self.assertEqual(list(self.agent_dir.glob("*-backup.*")), [])


if __name__ == "__main__":
    unittest.main()
