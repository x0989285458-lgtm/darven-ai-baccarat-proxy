import base64
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('fetch-portal-credentials.py')
spec = importlib.util.spec_from_file_location('fetch_portal_credentials', SCRIPT)
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)


class FetchPortalCredentialsTests(unittest.TestCase):
    def test_fetch_secret_decodes_without_logging_value(self):
        encoded = base64.b64encode(b'safe-value').decode('ascii')
        with patch.object(fetcher, 'request_json', return_value={'payload': {'data': encoded}}):
            self.assertEqual(fetcher.fetch_secret('project', 'access', 'secret-name'), 'safe-value')

    def test_atomic_write_is_root_only_shape_and_contains_exact_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'runtime' / 'portal.json'
            fetcher.atomic_write_secret(target, {'username': 'user', 'password': 'pass'})
            self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'username': 'user', 'password': 'pass'})
            if os.name != 'nt':
                self.assertEqual(target.stat().st_mode & 0o777, 0o400)
                self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)

    def test_main_prints_only_fixed_success_message(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'portal.json'
            def fake_request(url, _headers, timeout=20):
                if url.endswith('/token'):
                    return {'access_token': 'access'}
                value = b'user-secret' if 'username' in url else b'password-secret'
                return {'payload': {'data': base64.b64encode(value).decode('ascii')}}
            output = io.StringIO()
            with patch.object(fetcher, 'OUTPUT_PATH', target), \
                 patch.object(fetcher, 'metadata_text', return_value='project-id'), \
                 patch.object(fetcher, 'request_json', side_effect=fake_request), \
                 contextlib.redirect_stdout(output):
                fetcher.main()
            self.assertEqual(output.getvalue().strip(), 'portal credentials prepared')
            self.assertNotIn('user-secret', output.getvalue())
            self.assertNotIn('password-secret', output.getvalue())


if __name__ == '__main__':
    unittest.main()
