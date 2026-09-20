import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]


class FullSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rcs-setup-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.home = root / "home with spaces"
        self.repo = root / "checkout with spaces"
        self.bin = root / "brew/bin"
        self.home.mkdir()
        self.repo.mkdir()
        self.bin.mkdir(parents=True)
        self.log = root / "commands.log"
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin",
                        PI_CODING_AGENT_DIR=str(self.home / ".pi/agent"), PI_AUTO_UPDATE="0",
                        XDG_CONFIG_HOME=str(self.home / ".config"), XDG_DATA_HOME=str(self.home / ".local/share"),
                        TEST_LOG=str(self.log), REAL_NODE=shutil.which("node") or "node")
        for key in ("BASH_ENV", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "NVIM_APPNAME"):
            self.env.pop(key, None)
        for name in ("setup.sh", "setup-pi.sh", "setup-common.sh", "AGENTS.md"):
            shutil.copy2(REPO / name, self.repo / name)
        # Keep the Apple Silicon contract, but route its fixed Homebrew paths to a sandbox.
        script = self.repo / "setup.sh"
        script.write_text(script.read_text().replace("/opt/homebrew", str(self.bin.parent)))
        for name in ("pi", "skills", "nvim", "zshrc", "tmux.conf"):
            (self.repo / name).symlink_to(REPO / name)
        self.stub("uname", 'echo "${TEST_OS:-Darwin}"')
        self.stub("brew", f'''case "$1" in
  shellenv) printf 'export PATH="{self.bin}:$PATH"\\n' ;;
  --prefix) if [ "${{2:-}}" = fzf ]; then echo "{self.bin.parent}/fzf"; else echo "{self.bin.parent}"; fi ;;
  *) printf 'brew %s\\n' "$*" >> "$TEST_LOG"; exit "${{BREW_EXIT:-0}}" ;;
esac''')
        self.stub("node", '''if [ "$1" = -p ] || [ "${1##*/}" = settings.mjs ]; then exec "$REAL_NODE" "$@"; fi
printf 'node %s\\n' "$*" >> "$TEST_LOG"
exit "${NODE_EXIT:-0}"''')
        self.stub("npm", 'printf "npm %s\\n" "$*" >> "$TEST_LOG"; exit "${NPM_EXIT:-0}"')
        self.stub("nvim", 'printf "nvim %s app=%s\\n" "$*" "$NVIM_APPNAME" >> "$TEST_LOG"; exit "${NVIM_EXIT:-0}"')
        for name in ("rg", "fd", "qmd", "playwright-cli", "pip3"):
            self.stub(name, f'printf "{name} %s\\n" "$*" >> "$TEST_LOG"')
        fzf = self.bin.parent / "fzf/install"
        fzf.parent.mkdir()
        fzf.write_text('#!/bin/sh\nprintf "fzf\\n" >> "$TEST_LOG"\n')
        fzf.chmod(0o755)

    def stub(self, name, body):
        executable = self.bin / name
        executable.write_text("#!/bin/sh\n" + body + "\n")
        executable.chmod(0o755)

    def run_setup(self):
        return subprocess.run(["/bin/bash", str(self.repo / "setup.sh")], env=self.env,
                              cwd=self.home, capture_output=True, text=True, timeout=30)

    def assert_success(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_full_setup_and_rerun(self):
        self.stub("codex", "exit 0")
        self.stub("claude", "exit 0")
        self.assert_success()
        self.assertTrue((self.home / ".pi/agent/settings.json").is_file())
        self.assertFalse((self.home / ".pi/agent/settings.json").is_symlink())
        expected = {
            ".zshrc": "zshrc", ".tmux.conf": "tmux.conf", ".config/nvim": "nvim",
            ".pi/agent/AGENTS.md": "AGENTS.md",
            ".codex/AGENTS.md": "AGENTS.md", ".claude/CLAUDE.md": "AGENTS.md",
        }
        for harness, filename in (("codex", "AGENTS.md"), ("claude", "CLAUDE.md")):
            for account in ("work", "personal"):
                expected[f".{harness}/envs/{account}/{filename}"] = "AGENTS.md"
        for skill in ("schlep", "pi-maintenance"):
            expected[f".pi/agent/skills/{skill}"] = f"skills/{skill}"
            expected[f".codex/skills/{skill}"] = f"skills/{skill}"
            expected[f".claude/skills/{skill}"] = f"skills/{skill}"
            for account in ("work", "personal"):
                expected[f".claude/envs/{account}/skills/{skill}"] = f"skills/{skill}"
        self.assertFalse((self.home / ".codex/envs/work/skills").exists())
        inodes = {}
        for name, source in expected.items():
            path = self.home / name
            self.assertTrue(path.is_symlink(), name)
            self.assertEqual(path.resolve(), (self.repo / source).resolve())
            inodes[name] = path.lstat().st_ino
        # The reset is a one-time repository edit, not an installer operation.
        (self.repo / "AGENTS.md").write_text("New shared instructions\n")
        self.assert_success()
        for name in expected:
            self.assertEqual((self.home / name).lstat().st_ino, inodes[name])
        self.assertEqual((self.home / ".claude/CLAUDE.md").read_text(), "New shared instructions\n")
        self.assertEqual(len((self.home / ".zprofile").read_text().splitlines()), 1)
        self.assertEqual(list(self.home.rglob("*-backup.*")), [])
        log = self.log.read_text()
        self.assertIn("starship", log)
        self.assertIn("neovim", log)
        self.assertIn("@earendil-works/pi-coding-agent@", log)
        self.assertIn("npm:pi-subagents", log)
        self.assertEqual(log.count("nvim --headless -u NONE -i NONE -n -l"), 2)
        self.assertIn("app=nvim", log)
        self.assertIn('eval "$(starship init zsh)"', (REPO / "zshrc").read_text())

    def test_correct_relative_links_are_preserved(self):
        self.stub("codex", "exit 0")
        link = self.home / ".codex/AGENTS.md"
        link.parent.mkdir()
        link.symlink_to(os.path.relpath(self.repo / "AGENTS.md", link.parent))
        inode = link.lstat().st_ino
        self.assert_success()
        self.assert_success()
        self.assertEqual(link.lstat().st_ino, inode)
        self.assertEqual(list(self.home.rglob("*-backup.*")), [])

    def test_absent_harnesses_are_not_configured(self):
        self.assert_success()
        self.assertFalse((self.home / ".codex").exists())
        self.assertFalse((self.home / ".claude").exists())

    def test_custom_homes_native_claude_and_existing_state(self):
        self.env["CODEX_HOME"] = str(self.home / "custom codex")
        self.env["CLAUDE_CONFIG_DIR"] = str(self.home / "custom claude")
        self.env["XDG_CONFIG_HOME"] = str(self.home / "custom config")
        self.stub("codex", "exit 0")
        native = self.home / ".local/bin/claude"
        native.parent.mkdir(parents=True)
        native.write_text("#!/bin/sh\nexit 0\n")
        native.chmod(0o755)
        config = Path(self.env["XDG_CONFIG_HOME"]) / "nvim"
        config.mkdir(parents=True)
        (config / "init.lua").write_text("local previous = true\n")
        original = self.home / "old-zshrc"
        original.write_text("old shell config\n")
        (self.home / ".zshrc").symlink_to("old-zshrc")
        for key, filename in (("CODEX_HOME", "AGENTS.md"), ("CLAUDE_CONFIG_DIR", "CLAUDE.md")):
            home = Path(self.env[key])
            home.mkdir()
            (home / filename).write_text("previous instructions\n")
            (home / "auth.json").write_text("credential fixture\n")
        self.assert_success()
        self.assert_success()
        backups = self.home / ".local/state/rcs/backups"
        self.assertEqual(len(list(backups.glob("*-backup.*"))), 4)
        self.assertEqual(next(backups.glob("zshrc-backup.*/.zshrc")).resolve(), original)
        self.assertEqual(next(backups.glob("nvim-backup.*/nvim/init.lua")).read_text(), "local previous = true\n")
        for key, filename in (("CODEX_HOME", "AGENTS.md"), ("CLAUDE_CONFIG_DIR", "CLAUDE.md")):
            self.assertEqual((Path(self.env[key]) / filename).resolve(), self.repo / "AGENTS.md")
            self.assertEqual((Path(self.env[key]) / "auth.json").read_text(), "credential fixture\n")
        self.assertEqual(config.resolve(), REPO / "nvim")
        self.assertFalse((self.home / ".config/nvim").exists())

    def test_broken_symlink_is_backed_up(self):
        self.stub("codex", "exit 0")
        target = self.home / ".codex/AGENTS.md"
        target.parent.mkdir()
        target.symlink_to("missing.md")
        self.assert_success()
        backup = next((self.home / ".local/state/rcs/backups").glob("codex-instructions-backup.*")) / "AGENTS.md"
        self.assertTrue(backup.is_symlink())
        self.assertEqual(backup.resolve(), self.home / ".codex/missing.md")

    def test_install_failures_stop_setup(self):
        for variable, status in (("BREW_EXIT", 31), ("NPM_EXIT", 32), ("NVIM_EXIT", 33)):
            with self.subTest(variable=variable):
                self.env[variable] = str(status)
                result = self.run_setup()
                self.assertEqual(result.returncode, status, result.stdout + result.stderr)
                self.assertNotIn("Done.", result.stdout)
                del self.env[variable]

    def test_non_macos_fails_before_install(self):
        self.env["TEST_OS"] = "Linux"
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("macOS only", result.stderr)
        self.assertFalse(self.log.exists())


class NeovimBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.nvim = shutil.which("nvim")
        if not self.nvim:
            self.skipTest("Neovim is not installed")
        self.temp = tempfile.TemporaryDirectory(prefix="rcs-nvim-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / "config/nvim"
        self.config.mkdir(parents=True)
        self.env = dict(os.environ, HOME=str(self.root), NVIM_APPNAME="nvim",
                        XDG_CONFIG_HOME=str(self.root / "config"), XDG_DATA_HOME=str(self.root / "data"),
                        XDG_STATE_HOME=str(self.root / "state"), XDG_CACHE_HOME=str(self.root / "cache"))

    def run_bootstrap(self):
        return subprocess.run([self.nvim, "--headless", "-u", "NONE", "-i", "NONE", "-n", "-l",
                               str(REPO / "nvim/bootstrap.lua")], env=self.env, cwd=self.root,
                              capture_output=True, text=True, timeout=30)

    def test_init_error_is_nonzero(self):
        (self.config / "init.lua").write_text('error("fixture init failure")\n')
        result = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture init failure", result.stderr)

    def test_lazy_clone_failure_does_not_wait_for_input(self):
        (self.config / "init.lua").write_text(f'dofile({json.dumps(str(REPO / "nvim/lua/config/lazy.lua"))})\n')
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        git = fake_bin / "git"
        git.write_text('#!/bin/sh\necho "fixture clone failure" >&2\nexit 42\n')
        git.chmod(0o755)
        self.env["PATH"] = f"{fake_bin}:{self.env['PATH']}"
        result = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture clone failure", result.stderr)

    def git(self, directory, *args):
        env = dict(self.env, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        return subprocess.run(["git", *args], cwd=directory, env=env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def plugin(self, name):
        path = self.root / name
        path.mkdir()
        (path / "README").write_text("Offline plugin fixture\n")
        self.git(path, "init", "-b", "main")
        self.commit(path)
        return path

    def commit(self, path):
        self.git(path, "add", ".")
        self.git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-m", "fixture")
        return self.git(path, "rev-parse", "HEAD")

    def configure_lazy(self, spec, pins):
        installed = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "nvim/lazy/lazy.nvim"
        if not (installed / "lua/lazy/init.lua").exists():
            self.skipTest("Installed lazy.nvim is required for the offline integration test")
        lazy = self.root / "data/nvim/lazy/lazy.nvim"
        lazy.parent.mkdir(parents=True)
        # Never change the host's plugin checkout or contact an upstream remote.
        self.git(self.root, "clone", "--no-hardlinks", str(installed), str(lazy))
        pins["lazy.nvim"] = {"branch": self.git(lazy, "branch", "--show-current"),
                             "commit": self.git(lazy, "rev-parse", "HEAD")}
        self.lock = self.config / "lazy-lock.json"
        self.lock.write_text(json.dumps(pins) + "\n")
        (self.config / "init.lua").write_text(f'''
vim.opt.rtp:prepend({json.dumps(str(lazy))})
local lazy = require("lazy")
local setup = lazy.setup
lazy.setup = function(options)
  options.spec = {spec}
  options.install.colorscheme = {{}}
  options.checker.enabled = false
  options.change_detection = {{ enabled = false }}
  options.pkg = {{ enabled = false }}
  setup(options)
end
dofile({json.dumps(str(REPO / "nvim/lua/config/lazy.lua"))})
''')

    def test_real_lazy_install_restore_and_build_failure(self):
        plugin = self.plugin("fixture-plugin")
        commit = self.git(plugin, "rev-parse", "HEAD")
        spec = f'''{{{{ url = {json.dumps(plugin.as_uri())}, name = "LazyVim", build = function()
          if vim.env.TEST_BUILD_FAIL == "1" then error("fixture build failure") end
        end }}}}'''
        self.configure_lazy(spec, {"LazyVim": {"branch": "main", "commit": commit}})
        before = self.lock.read_bytes()
        for _ in range(2):
            result = self.run_bootstrap()
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(self.lock.read_bytes(), before)
            self.assertEqual(self.git(self.root / "data/nvim/lazy/LazyVim", "rev-parse", "HEAD"), commit)
        shutil.rmtree(self.root / "data/nvim/lazy/LazyVim")
        self.env["TEST_BUILD_FAIL"] = "1"
        result = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture build failure", result.stdout + result.stderr)
        self.assertEqual(self.lock.read_bytes(), before)

    def assert_startup_failure(self, extra_spec, expected):
        plugin = self.plugin("fixture-plugin")
        commit = self.git(plugin, "rev-parse", "HEAD")
        spec = f'{{{{url = {json.dumps(plugin.as_uri())}, name = "LazyVim", {extra_spec}}}}}'
        self.configure_lazy(spec, {"LazyVim": {"branch": "main", "commit": commit}})
        before = self.lock.read_bytes()
        result = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(expected, result.stdout + result.stderr)
        self.assertEqual(self.lock.read_bytes(), before)

    def test_invalid_import_is_nonzero(self):
        self.assert_startup_failure('import = "missing_fixture_specs"', "No specs found")

    def test_plugin_init_error_is_nonzero(self):
        self.assert_startup_failure('init = function() error("fixture init error") end', "fixture init error")

    def test_plugin_config_error_is_nonzero(self):
        self.assert_startup_failure('config = function() error("fixture config error") end', "fixture config error")

    def test_lazyvim_buffered_config_error_is_nonzero(self):
        util = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "nvim/lazy/LazyVim/lua/lazyvim/util/init.lua"
        if not util.exists():
            self.skipTest("Installed LazyVim utility is required for buffered notification test")
        extra = f'''init = function()
          dofile({json.dumps(str(util))}).lazy_notify()
        end, config = function() error("fixture buffered config error") end'''
        self.assert_startup_failure(extra, "fixture buffered config error")

    def test_locked_restore_with_drift_missing_plugins_and_import_rounds(self):
        dependency = self.plugin("dependency")
        pinned_dependency = self.git(dependency, "rev-parse", "HEAD")
        (dependency / "README").write_text("New dependency commit\n")
        self.commit(dependency)
        plugin = self.plugin("fixture-plugin")
        imports = plugin / "lua/fixture_specs/init.lua"
        imports.parent.mkdir(parents=True)
        imports.write_text(f'return {{{{url = {json.dumps(dependency.as_uri())}, name = "Dependency"}}}}\n')
        pinned_plugin = self.commit(plugin)
        imports.write_text("return {}\n")
        drifted = self.commit(plugin)
        spec = f'{{{{url = {json.dumps(plugin.as_uri())}, name = "LazyVim", import = "fixture_specs"}}}}'
        self.configure_lazy(spec, {"LazyVim": {"branch": "main", "commit": pinned_plugin},
                                   "Dependency": {"branch": "main", "commit": pinned_dependency}})
        before = self.lock.read_bytes()
        for mixed in (False, True):
            with self.subTest(mixed=mixed):
                if mixed:
                    self.git(self.root / "data/nvim/lazy/LazyVim", "checkout", drifted)
                    shutil.rmtree(self.root / "data/nvim/lazy/Dependency")
                result = self.run_bootstrap()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.lock.read_bytes(), before)
                for name, pin in (("LazyVim", pinned_plugin), ("Dependency", pinned_dependency)):
                    self.assertEqual(self.git(self.root / "data/nvim/lazy" / name, "rev-parse", "HEAD"), pin)


if __name__ == "__main__":
    unittest.main()
