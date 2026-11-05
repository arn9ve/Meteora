import unittest

from set_sta_mode import require_credentials


class CredentialRules(unittest.TestCase):
    def test_clean_pair(self):
        self.assertEqual(require_credentials("hackathon", "hackathon"), ("hackathon", "hackathon"))

    def test_missing_value(self):
        for ssid, password in (("", "hackathon"), ("hackathon", None), ("   ", "secret"), (None, "secret")):
            with self.assertRaises(ValueError):
                require_credentials(ssid, password)

    def test_embedded_space(self):
        with self.assertRaises(ValueError):
            require_credentials("hack athon", "hackathon")
        with self.assertRaises(ValueError):
            require_credentials("hackathon", "hack athon")


if __name__ == "__main__":
    unittest.main()
