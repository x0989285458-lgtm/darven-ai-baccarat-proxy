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
        'lastRoundAt': datetime.now(timezone.utc).isoformat(),
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

    def test_fresh_heartbeat_cannot_mask_stale_authoritative_round_progress(self):
        stale = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        fresh = datetime.now(timezone.utc).isoformat()
        self.assertFalse(self.inspect_with(healthy_status(lastRoundAt=stale, lastTablesAt=fresh, lastMessageAt=fresh))[3])

    def test_rejects_missing_stale_and_materially_future_timestamps(self):
        self.assertFalse(self.inspect_with(healthy_status(lastRoundAt=None, lastTablesAt=None))[3])
        self.assertFalse(self.inspect_with(healthy_status(lastRoundAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()))[3])
        self.assertFalse(self.inspect_with(healthy_status(lastRoundAt=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()))[3])


def formal_worker_snapshot_error(message='TypeError: fetch failed'):
    return {
        'connected': False,
        'authenticated': False,
        'tableCount': 0,
        'eventLayer': 'capture_error',
        'eventComponent': 'cloud_capture',
        'eventKind': 'worker_snapshot',
        'eventMessage': message,
    }


class WatchdogRecoveryTests(unittest.TestCase):
    def test_stale_progress_worker_health_is_split_without_guessing(self):
        self.assertEqual(watchdog.classify_stale_worker_health({
            'ok': False, 'reason': 'legacy_mutable_queue_requires_cutover',
            'source': {'connected': True, 'authenticated': True, 'tableCount': 10},
            'push': {'stateInvalid': True, 'legacyMutableQueueDetected': True, 'queueEntryCount': 2},
        }), 'legacy_mutable_queue_requires_cutover')
        self.assertEqual(watchdog.classify_stale_worker_health({
            'push': {'stateInvalid': True},
        }), 'push_durable_state_invalid')
        self.assertEqual(watchdog.classify_stale_worker_health({
            'push': {'stateInvalid': False, 'queueEntryCount': 4, 'consecutiveFailures': 3},
        }), 'push_delivery_failed')
        self.assertEqual(watchdog.classify_stale_worker_health({
            'ok': False, 'reason': 'source_progress_stale',
            'source': {
                'connected': True, 'authenticated': True, 'tableCount': 10,
                'sourceProgressAt': (datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat(),
            },
            'push': {'stateInvalid': False, 'queueEntryCount': 0, 'consecutiveFailures': 0},
        }), 'worker_source_stale')
        self.assertEqual(watchdog.classify_stale_worker_health({
            'ok': True,
            'source': {
                'connected': True, 'authenticated': True, 'tableCount': 10,
                'sourceProgressAt': datetime.now(timezone.utc).isoformat(),
            },
            'push': {'stateInvalid': False, 'queueEntryCount': 0, 'consecutiveFailures': 0},
        }), 'proxy_progress_inconsistent')

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
             patch.object(watchdog, 'fetch_gcp_worker_health', return_value={
                 'ok': False, 'reason': 'source_unavailable',
                 'source': {'connected': True, 'authenticated': False, 'tableCount': 0},
                 'push': {'stateInvalid': False, 'queueEntryCount': 0, 'consecutiveFailures': 0},
             }), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)), \
             contextlib.redirect_stdout(output):
            watchdog.main()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'worker_source_unhealthy')
        self.assertIn('授權', output.getvalue())

    def test_stale_authenticated_capture_alerts_without_restarting_worker(self):
        stale = (healthy_status(lastRoundAt=(datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()), 10, 999, False)
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=stale), \
             patch.object(watchdog, 'fetch_gcp_worker_health', return_value={
                 'ok': True,
                 'source': {
                     'connected': True, 'authenticated': True, 'tableCount': 10,
                     'sourceProgressAt': datetime.now(timezone.utc).isoformat(),
                 },
                 'push': {'stateInvalid': False, 'queueEntryCount': 0, 'consecutiveFailures': 0},
             }), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
            watchdog.main()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'proxy_progress_inconsistent')

    def test_invalid_proxy_timestamp_checks_worker_health_before_any_recovery(self):
        invalid = (healthy_status(lastRoundAt=(datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()), 10, -600, False)
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=invalid), \
             patch.object(watchdog, 'fetch_gcp_worker_health', return_value={
                 'ok': True,
                 'source': {
                     'connected': True, 'authenticated': True, 'tableCount': 10,
                     'sourceProgressAt': datetime.now(timezone.utc).isoformat(),
                 },
                 'push': {'stateInvalid': False, 'queueEntryCount': 0, 'consecutiveFailures': 0},
             }) as health_read, \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
            watchdog.main()
        health_read.assert_called_once_with()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'proxy_progress_inconsistent')

    def test_invalid_proxy_timestamp_with_unreachable_worker_health_never_restarts(self):
        invalid = (healthy_status(lastRoundAt=(datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()), 10, -600, False)
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=invalid), \
             patch.object(watchdog, 'fetch_gcp_worker_health', side_effect=TimeoutError('worker health unavailable')) as health_read, \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
            watchdog.main()
        health_read.assert_called_once_with()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'worker_health_unavailable')

    def test_disconnected_proxy_uses_worker_health_to_identify_push_backlog(self):
        disconnected = ({'connected': False, 'authenticated': False, 'tableCount': 0}, 0, 999, False)
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=disconnected), \
             patch.object(watchdog, 'fetch_gcp_worker_health', return_value={
                 'ok': False, 'reason': 'push_delivery_failed',
                 'source': {'connected': True, 'authenticated': True, 'tableCount': 10},
                 'push': {'queueEntryCount': 4, 'queuedRoundKeyCount': 7, 'consecutiveFailures': 3},
             }), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
            watchdog.main()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'push_delivery_failed')

    def test_proxy_timeout_never_restarts_worker(self):
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', side_effect=TimeoutError('proxy timeout')), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
            watchdog.main()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'proxy_unreachable')

    def test_database_backpressure_never_restarts_worker(self):
        blocked_status = healthy_status(
            eventLayer='write_error',
            eventComponent='supabase_writer',
            eventKind='persist_capture',
            eventMessage='database timeout',
        )
        blocked = (blocked_status, 10, 999, False)
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', return_value=blocked), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
            watchdog.main()
        restart.assert_not_called()
        self.assertEqual(saved[-1]['failure_kind'], 'persistence_backpressure')

    def test_formal_worker_snapshot_transport_error_restarts_once_and_recovers(self):
        disconnected = (formal_worker_snapshot_error(), 0, 999, False)
        recovered = (healthy_status(), 10, 1, True)
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', side_effect=[disconnected, recovered]), \
             patch.object(watchdog, 'fetch_gcp_worker_health', side_effect=TimeoutError('worker health unavailable')) as health_read, \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog.time, 'sleep'), \
             patch.object(watchdog, 'save_state') as save:
            watchdog.main()
        health_read.assert_called_once_with()
        restart.assert_called_once_with()
        self.assertFalse(save.call_args.args[0]['alerting'])
        self.assertIn('last_worker_restart_at', save.call_args.args[0])

    def test_formal_worker_snapshot_non_transport_errors_never_restart(self):
        for message in ('version_mismatch: worker buildVersion must be 105', 'Cloud capture worker failed: 401 unauthorized'):
            saved = []
            snapshot_error = (formal_worker_snapshot_error(message), 0, 999, False)
            with self.subTest(message=message), \
                 patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
                 patch.object(watchdog, 'inspect', return_value=snapshot_error), \
                 patch.object(watchdog, 'fetch_gcp_worker_health', return_value={
                     'ok': False, 'reason': 'source_unavailable',
                     'source': {'connected': False, 'authenticated': False, 'tableCount': 0},
                     'push': {'stateInvalid': False, 'queueEntryCount': 0, 'consecutiveFailures': 0},
                 }), \
                 patch.object(watchdog, 'restart_gcp_worker') as restart, \
                 patch.object(watchdog, 'save_state', side_effect=lambda state: saved.append(state)):
                watchdog.main()
            restart.assert_not_called()
            self.assertEqual(saved[-1]['failure_kind'], 'worker_source_unhealthy')

    def test_healthy_recovery_preserves_last_failure_evidence(self):
        state = {
            'alerting': True,
            'failure_kind': 'proxy_unreachable',
            'first_alerted_at': '2026-07-28T13:20:00+00:00',
            'last_checked_at': '2026-07-28T13:23:00+00:00',
            'last_error': 'TimeoutError: proxy timeout',
            'last_error_at': '2026-07-28T13:23:00+00:00',
        }
        output = io.StringIO()
        with patch.object(watchdog, 'load_state', return_value=state), \
             patch.object(watchdog, 'inspect', return_value=(healthy_status(), 10, 1, True)), \
             patch.object(watchdog, 'save_state') as save, \
             contextlib.redirect_stdout(output):
            watchdog.main()
        saved = save.call_args.args[0]
        self.assertFalse(saved['alerting'])
        self.assertEqual(output.getvalue(), '', 'natural recovery without an automatic action must stay silent')
        self.assertEqual(saved['last_failure'], {
            'kind': 'proxy_unreachable',
            'first_alerted_at': '2026-07-28T13:20:00+00:00',
            'last_checked_at': '2026-07-28T13:23:00+00:00',
            'error': 'TimeoutError: proxy timeout',
            'error_at': '2026-07-28T13:23:00+00:00',
        })

    def test_healthy_recovery_notifies_only_after_real_automatic_restart(self):
        state = {
            'alerting': True,
            'failure_kind': 'worker_transport_confirmed',
            'first_alerted_at': '2026-07-28T13:20:00+00:00',
            'last_checked_at': '2026-07-28T13:23:00+00:00',
            'attempted': ['gcp-worker-restart'],
            'last_worker_restart_at': '2026-07-28T13:22:00+00:00',
        }
        output = io.StringIO()
        with patch.object(watchdog, 'load_state', return_value=state), \
             patch.object(watchdog, 'inspect', return_value=(healthy_status(), 10, 1, True)), \
             patch.object(watchdog, 'save_state'), \
             contextlib.redirect_stdout(output):
            watchdog.main()
        self.assertIn('已自動恢復', output.getvalue())
        self.assertIn('gcp-worker-restart', output.getvalue())
        self.assertNotIn('不需要', output.getvalue())

    def test_restart_budget_blocks_repeated_disconnect_after_a_brief_recovery(self):
        disconnected = (formal_worker_snapshot_error(), 0, 999, False)
        recent = datetime.now(timezone.utc).isoformat()
        state = {'alerting': False, 'last_worker_restart_at': recent}
        with patch.object(watchdog, 'load_state', return_value=state), \
             patch.object(watchdog, 'inspect', return_value=disconnected), \
             patch.object(watchdog, 'fetch_gcp_worker_health', side_effect=TimeoutError('worker health unavailable')), \
             patch.object(watchdog, 'restart_gcp_worker') as restart, \
             patch.object(watchdog, 'save_state'):
            watchdog.main()
        restart.assert_not_called()

    def test_failed_reinspection_is_reported(self):
        disconnected = (formal_worker_snapshot_error(), 0, 999, False)
        output = io.StringIO()
        with patch.object(watchdog, 'load_state', return_value={'alerting': False}), \
             patch.object(watchdog, 'inspect', side_effect=[disconnected, RuntimeError('reinspect failed')]), \
             patch.object(watchdog, 'fetch_gcp_worker_health', side_effect=TimeoutError('worker health unavailable')), \
             patch.object(watchdog, 'restart_gcp_worker'), \
             patch.object(watchdog.time, 'sleep'), \
             patch.object(watchdog, 'save_state'), \
             contextlib.redirect_stdout(output):
            watchdog.main()
        self.assertIn('reinspect failed', output.getvalue())

    def test_alerting_state_persists_and_reports_changed_reinspection_error(self):
        disconnected = (formal_worker_snapshot_error(), 0, 999, False)
        output = io.StringIO()
        saved = []
        with patch.object(watchdog, 'load_state', return_value={'alerting': True, 'first_alerted_at': 'earlier', 'last_error': 'old error'}), \
             patch.object(watchdog, 'inspect', side_effect=[disconnected, RuntimeError('reinspect failed')]), \
             patch.object(watchdog, 'fetch_gcp_worker_health', side_effect=TimeoutError('worker health unavailable')), \
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
