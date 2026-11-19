import io
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from yt_dlp.cookies import YoutubeDLCookieJar
from backend.workers.protocol import WorkerError
from backend.workers.youtube_auth import normalize_cookies, save, load, protect, youtube_options, auth_error, run


def cookies():
    return '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\ttest-secret-ONLY\n.example.com\tTRUE\t/\tTRUE\t0\tOTHER\tforeign-secret\n'


class YoutubeAuthTests(unittest.TestCase):
    def test_import_keeps_only_youtube_login_and_parses_as_ytdlp_cookie_jar(self):
        text, count = normalize_cookies(cookies())
        self.assertEqual(count, 1)
        self.assertNotIn('foreign-secret', text)
        jar = YoutubeDLCookieJar(io.StringIO(text))
        jar.load()
        self.assertEqual(len(list(jar)), 1)
        self.assertEqual(list(jar)[0].name, 'SAPISID')

    def test_rejects_expired_anonymous_foreign_or_invalid_cookie_files(self):
        invalid = ['{}', cookies().replace('SAPISID', 'VISITOR_INFO1_LIVE'), cookies().replace('.youtube.com', '.youtube.com.evil.com'), cookies().replace('\t0\t', '\t1\t'), cookies().replace('\tTRUE\t/\t', '\tMAYBE\t/\t'), '# Netscape HTTP Cookie File\ninvalid']
        for text in invalid:
            with self.subTest(text=text[:35]), self.assertRaises(WorkerError):
                normalize_cookies(text)

    def test_rejects_oversized_file(self):
        with self.assertRaises(WorkerError):
            normalize_cookies('x' * (1024 * 1024 + 1))

    def test_bot_error_has_dedicated_code_without_raw_diagnostics(self):
        error = auth_error(RuntimeError("ERROR: Sign in to confirm you're not a bot. --cookies raw-diagnostic"))
        self.assertEqual(error.code, 'YOUTUBE_AUTH_REQUIRED')
        self.assertIn('B 站账号无需重新登录', str(error))
        self.assertNotIn('raw-diagnostic', str(error))
        original = RuntimeError('connection timed out')
        self.assertIs(auth_error(original), original)

    def test_missing_login_does_not_change_anonymous_download_options(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(youtube_options(directory), {})

    @unittest.skipUnless(os.name == 'nt', 'Windows user encryption')
    def test_dpapi_storage_status_memory_jar_and_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            status = save(cookies(), directory)
            self.assertTrue(status['configured'])
            path = Path(directory) / 'youtube/session.credential'
            self.assertNotIn(b'test-secret', path.read_bytes())
            self.assertNotIn(b'foreign-secret', path.read_bytes())
            self.assertIn('test-secret-ONLY', load(directory)['cookies'])
            options = youtube_options(directory)
            self.assertIsInstance(options['cookiefile'], io.StringIO)
            public = run({'command': 'status', 'dataDir': directory})
            self.assertEqual(public['cookieCount'], 1)
            self.assertNotIn('cookies', public)
            with self.assertRaises(WorkerError):
                save('{}', directory)
            self.assertTrue(run({'command': 'status', 'dataDir': directory})['configured'])
            self.assertFalse(run({'command': 'clear', 'dataDir': directory})['configured'])
            self.assertFalse(path.exists())

    def test_channel_worker_uses_owned_auth_without_cookie_arguments(self):
        from backend.workers.channel_monitor import run as channel_run
        with patch('backend.workers.channel_monitor.youtube_options', return_value={'cookiefile': io.StringIO('memory')}) as auth, patch('backend.workers.channel_monitor.YoutubeDL') as downloader:
            downloader.return_value.__enter__.return_value.extract_info.return_value = {'id': 'abcdefghijk', 'formats': [{'format_id': '18'}]}
            result = channel_run({'command': 'check', 'url': 'https://youtu.be/abcdefghijk', 'dataDir': 'owned-data', 'proxyPort': 7897, 'node': 'node'})
            auth.assert_called_once_with('owned-data')
            self.assertEqual(result['formatCount'], 1)
            self.assertIsInstance(downloader.call_args.args[0]['cookiefile'], io.StringIO)

    def test_scan_does_not_reuse_consumed_cookie_stream(self):
        from backend.workers.channel_monitor import run as channel_run
        channel_id = 'UC1234567890123456789012'
        head, cursor = 'abcdefghijk', 'zzzzzzzzzzz'
        opened = []

        class Downloader:
            def __init__(self, options):
                stream = options.get('cookiefile')
                if stream is not None:
                    jar = YoutubeDLCookieJar(stream)
                    jar.load()
                opened.append(stream)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                pass

            def extract_info(self, url, download=False):
                if '/videos' in url:
                    return {'channel_id': channel_id, 'entries': [{'id': head}, {'id': cursor}]}
                return {'id': head, 'channel_id': channel_id, 'timestamp': 10}

        with patch('backend.workers.youtube_auth.load', return_value={'cookies': normalize_cookies(cookies())[0]}), patch('backend.workers.channel_monitor.YoutubeDL', Downloader):
            result = channel_run({'command':'scan','url':channel_id,'cursor':cursor,'addedAt':0,'addedDate':'19700101','node':'node'})
        self.assertEqual(len(opened), 2)
        self.assertIsNone(opened[0])
        self.assertIsInstance(opened[1], io.StringIO)
        self.assertEqual(result['cursor'], head)
        self.assertEqual([video['id'] for video in result['videos']], [head])

    @unittest.skipUnless(os.name == 'nt', 'Windows user encryption')
    def test_unchanged_browser_snapshot_does_not_rearm_waiting_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            first = save(cookies(), directory, only_changed=True)
            anonymous_update = cookies() + '.youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tchanged\n'
            with patch('backend.workers.youtube_auth.protect', wraps=protect) as crypt:
                self.assertEqual(save(anonymous_update, directory, only_changed=True), first)
                self.assertTrue(all(call.kwargs.get('decrypt') for call in crypt.call_args_list))
            second = save(cookies().replace('test-secret-ONLY', 'refreshed'), directory, only_changed=True)
            self.assertTrue(second['configured'])
            self.assertIn('refreshed', load(directory)['cookies'])


if __name__ == '__main__':
    unittest.main()
