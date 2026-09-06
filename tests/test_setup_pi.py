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
        self.env = dict(os.environ, PI_CODING_AGENT_DIR=str(self.agent_dir))

    def run_setup(self, *args):
        return subprocess.run(
            ["bash", str(REPO / "setup-pi.sh"), *args],
            env=self.env, capture_output=True, text=True, check=True,
        )

    def test_fresh_install_and_rerun_preserve_auth_and_sessions(self):
        auth = self.agent_dir / "auth.json"
        auth.write_text('{"test": "local credential fixture"}\n')
        auth.chmod(0o600)
        sessions = self.agent_dir / "sessions"
        sessions.mkdir()
        session = sessions / "test.jsonl"
        session.write_text("local session fixture\n")

        self.run_setup("--skip-install")
        self.assertEqual(self.settings.resolve(), REPO / "pi/settings.json")
        link_inode = self.settings.lstat().st_ino
        self.run_setup("--skip-install")

        self.assertEqual(self.settings.lstat().st_ino, link_inode)
        self.assertEqual(list(self.agent_dir.glob("settings-backup.*")), [])
        self.assertEqual(auth.read_text(), '{"test": "local credential fixture"}\n')
        self.assertEqual(auth.stat().st_mode & 0o777, 0o600)
        self.assertEqual(session.read_text(), "local session fixture\n")

    def test_existing_settings_are_backed_up_once(self):
        previous = '{"defaultProvider": "another-provider"}\n'
        self.settings.write_text(previous)
        self.run_setup("--skip-install")
        self.run_setup("--skip-install")

        backups = list(self.agent_dir.glob("settings-backup.*/settings.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), previous)
        self.assertEqual(self.settings.resolve(), REPO / "pi/settings.json")

    def test_existing_symlink_target_is_untouched(self):
        other = Path(self.temp.name) / "other.json"
        other.write_text('{"theme": "light"}\n')
        self.settings.symlink_to(other)
        self.run_setup("--skip-install")

        backup = next(self.agent_dir.glob("settings-backup.*/settings.json"))
        self.assertTrue(backup.is_symlink())
        self.assertEqual(backup.resolve(), other.resolve())
        self.assertEqual(other.read_text(), '{"theme": "light"}\n')

    def test_failed_package_install_leaves_settings_untouched(self):
        fake_bin = Path(self.temp.name) / "bin"
        fake_bin.mkdir()
        node = fake_bin / "node"
        node.write_text("#!/bin/sh\nexit 0\n")
        node.chmod(0o755)
        npm = fake_bin / "npm"
        npm.write_text("#!/bin/sh\nexit 42\n")
        npm.chmod(0o755)
        self.env["PATH"] = f"{fake_bin}:{self.env['PATH']}"
        self.settings.write_text("{}\n")

        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.run_setup()
        self.assertEqual(failure.exception.returncode, 42)
        self.assertFalse(self.settings.is_symlink())
        self.assertEqual(self.settings.read_text(), "{}\n")
        self.assertEqual(list(self.agent_dir.glob("settings-backup.*")), [])


if __name__ == "__main__":
    unittest.main()
