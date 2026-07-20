import contextlib
import importlib.util
import io
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('ai_baccarat_data_watchdog.py')
spec = importlib.util.spec_from_file_location('ai_baccarat_data_watchdog', SCRIPT)
watchdog = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = watchdog
spec.loader.exec_module(watchdog)


def healthy_status(**overrides):
    value = {
        'connected': True,
        'authenticated': True,
        'tableCount': 10,
        'lastTablesAt': datetime.now(timezone.utc).isoformat(),
    }
    value.update(overrides)
    return value


class WatchdogTablePolicyTests(unittest.TestCase):
    def inspect_with(self, status):
        with patch.object(watchdog, 'fetch_json', return_value=status) as fetch:
            result = watchdog.inspect()
        fetch.assert_called_once_with(watchdog.STATUS_URL)
        return result

    def test_exact_approved_table_count_is_healthy(self):
        self.assertTrue(self.inspect_with(healthy_status())[3])

    def test_missing_extra_or_non_integer_table_counts_are_unhealthy(self):
        for value in (9, 11, 10.9, '10', True, None):
            self.assertFalse(self.inspect_with(healthy_status(tableCount=value))[3], value)

    def test_requires_literal_true_connection_flags(self):
        self.assertFalse(self.inspect_with(healthy_status(connected='false'))[3])
        self.assertFalse(self.inspect_with(healthy_status(authenticated='false'))[3])

    def test_uses_freshest_valid_status_timestamp(self):
        stale = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        fresh = datetime.now(timezone.utc).isoformat()
        malformed = 'not-a-date'
        self.assertTrue(self.inspect_with(healthy_status(lastTablesAt=stale, lastMessageAt=fresh))[3])
        self.assertTrue(self.inspect_with(healthy_status(lastTablesAt=malformed, lastRoundAt=fresh))[3])

    def test_rejects_missing_stale_and_materially_future_timestamps(self):
        self.assertFalse(self.inspect_with(healthy_status(lastTablesAt=None))[3])
        self.assertFalse(self.inspect_with(healthy_status(lastTablesAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()))[3])
        self.assertFalse(self.inspect_with(healthy_status(lastTablesAt=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()))[3])


class WatchdogRecoveryTests(unittest.TestCase):
    def test_authenticated_post_does_not_follow_redirect_or_forward_token(self):
        target_headers = []

        class Target(BaseHTTPRequestHandler):
            def do_POST(self):
                target_headers.append(self.headers.get('x-control-token'))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *_args):
                pass

        target = ThreadingHTTPServer(('127.0.0.1', 0), Target)

        class Redirect(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(307)
                self.send_header('Location', f'http://127.0.0.1:{target.server_port}/target')
                self.end_headers()

            def log_message(self, *_args):
                pass

        redirect = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (target, redirect)]
        for thread in threads:
            thread.start()
        try:
            redirect_url = f'http://127.0.0.1:{redirect.server_port}/start'
            with patch.object(watchdog, 'BASE', f'http://127.0.0.1:{redirect.server_port}'):
                with self.assertRaises(HTTPError):
                    watchdog.fetch_json(redirect_url, method='POST', token='secret')
            self.assertEqual(target_headers, [])
        finally:
            redirect.shutdown()
            target.shutdown()
            redirect.server_close()
            target.server_close()

    def test_missing_env_file_does_not_terminate_healthy_inspection(self):
        with patch.object(watchdog, 'load_env', side_effect=FileNotFoundError('missing env')), \
             patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=(healthy_status(), 10, 1, True)), \
             patch.object(watchdog, 'save_state') as save:
            watchdog.main()
        self.assertFalse(save.call_args.args[0]['alerting'])

    def test_authorization_loss_waits_for_worker_refresh_without_restart(self):
        unauthorized = ({'connected': True, 'authenticated': False, 'tableCount': 0}, 0, 999, False)
        output = io.StringIO()
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=unauthorized), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)), \
             contextlib.redirect_stdout(output):
            watchdog.main()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'authorization_lost')
        self.assertIn('授權', output.getvalue())

    def test_stale_authenticated_capture_restarts_worker_once_and_recovers(self):
        stale = (healthy_status(lastTablesAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()), 10, 999, False)
        recovered = (healthy_status(), 10, 1, True)
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', side_effect=[stale, recovered]), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog.time, 'sleep'), \
             patch.object(watchdog, 'save_state') as save:
            watchdog.main()
        restart.assert_called_once_with()
        self.assertFalse(save.call_args.args[0]['alerting'])

    def test_same_incident_never_restarts_again_after_the_first_attempt(self):
        stale = (healthy_status(lastTablesAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()), 10, 999, False)
        old_attempt = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        state = {'alerting': True, 'failure_kind': 'capture_stale', 'last_recovery_attempt_at': old_attempt}
        with patch.object(watchdog, 'load_state', return_value=state), \
             patch.object(watchdog, 'inspect', return_value=stale), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state'):
            watchdog.main()
        restart.assert_not_called()

    def test_failed_reinspection_is_reported(self):
        stale = (healthy_status(lastTablesAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()), 10, 999, False)
        output = io.StringIO()
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', side_effect=[stale, RuntimeError('reinspect failed')]), \
             patch.object(watchdog, 'restart_gcp_worker'), \
             patch.object(watchdog.time, 'sleep'), \
             patch.object(watchdog, 'save_state'), \
             contextlib.redirect_stdout(output):
            watchdog.main()
        self.assertIn('reinspect failed', output.getvalue())

    def test_alerting_state_persists_and_reports_changed_reinspection_error(self):
        stale = (healthy_status(lastTablesAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()), 10, 999, False)
        output = io.StringIO()
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': True, 'first_alerted_at': 'earlier', 'last_error': 'old error'}), \
             patch.object(watchdog, 'inspect', side_effect=[stale, RuntimeError('reinspect failed')]), \
             patch.object(watchdog, 'restart_gcp_worker'), \
             patch.object(watchdog.time, 'sleep'), \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)), \
             contextlib.redirect_stdout(output):
            watchdog.main()
        self.assertIn('reinspect failed', output.getvalue())
        self.assertEqual(saved[-1]['last_error'], 'RuntimeError: reinspect failed')
        self.assertIn('last_error_at', saved[-1])


if __name__ == '__main__':
    unittest.main()
