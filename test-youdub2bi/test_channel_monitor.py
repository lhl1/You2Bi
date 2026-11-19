import unittest
from unittest.mock import patch
from backend.workers.channel_monitor import channel_url, regular, single_video_url, channel_profile, video_metadata, run, cache_avatar
from backend.workers.protocol import WorkerError

class ChannelMonitorTests(unittest.TestCase):
    def test_normalizes_channels(self):
        self.assertEqual(channel_url('@example'),'https://www.youtube.com/@example/videos')
        self.assertEqual(channel_url('https://www.youtube.com/@example/featured'),'https://www.youtube.com/@example/videos')
        self.assertEqual(channel_url('UC1234567890123456789012'),'https://www.youtube.com/channel/UC1234567890123456789012/videos')

    def test_rejects_non_channels(self):
        for value in ['https://example.org/@test','https://www.youtube.com/watch?v=abcdefghijk','https://www.youtube.com/playlist?list=abc','https://user@www.youtube.com/@test']:
            with self.assertRaises(ValueError): channel_url(value)

    def test_excludes_shorts_and_all_live_states(self):
        self.assertTrue(regular({'live_status':'not_live','webpage_url':'https://www.youtube.com/watch?v=abcdefghijk'}))
        for field in [{'is_live':True},{'was_live':True},{'live_status':'was_live'},{'live_status':'is_upcoming'},{'webpage_url':'https://www.youtube.com/shorts/abcdefghijk'}]:
            self.assertFalse(regular(field))

    def test_manual_urls_accept_watch_short_links_and_shorts(self):
        for url in ['https://youtu.be/abcdefghijk?t=1','https://www.youtube.com/watch?v=abcdefghijk&list=example','https://www.youtube.com/shorts/abcdefghijk']:
            self.assertEqual(single_video_url(url),'https://www.youtube.com/watch?v=abcdefghijk')

    def test_manual_urls_reject_other_sites_channels_and_playlists(self):
        for url in ['https://example.org/watch?v=abcdefghijk','https://www.youtube.com/@creator','https://www.youtube.com/playlist?list=abc','https://www.bilibili.com/video/BV1abcdefghj']:
            with self.assertRaises((ValueError,WorkerError)): single_video_url(url)

    def test_profile_chooses_avatar_instead_of_banner_and_preserves_zero(self):
        info={'channel_id':'UC1234567890123456789012','channel':'Creator','uploader_id':'@creator','channel_follower_count':0,'channel_is_verified':True,'thumbnails':[{'url':'https://i.ytimg.com/banner','width':2000,'height':300},{'url':'https://yt3.googleusercontent.com/avatar','width':900,'height':900}]}
        result=channel_profile(info,{'id':'abcdefghijk'})
        self.assertEqual(result['avatarUrl'],'https://yt3.googleusercontent.com/avatar')
        self.assertEqual(result['subscriberCount'],0)
        self.assertTrue(result['isVerified'])
        self.assertEqual(result['handle'],'@creator')
        self.assertEqual(result['cursor'],'abcdefghijk')

    def test_manual_video_allows_replays_but_rejects_active_live(self):
        request={'command':'video','url':'https://youtu.be/abcdefghijk','node':'node'}
        info={'id':'abcdefghijk','title':'Video','channel':'Creator','live_status':'was_live','was_live':True}
        with patch('backend.workers.channel_monitor.YoutubeDL') as downloader:
            downloader.return_value.__enter__.return_value.extract_info.return_value=info
            self.assertEqual(run(request)['id'],'abcdefghijk')
            self.assertEqual(downloader.call_args.args[0]['proxy'],'http://127.0.0.1:7897')
            for state in ['is_live','is_upcoming','post_live']:
                downloader.return_value.__enter__.return_value.extract_info.return_value={**info,'live_status':state}
                with self.assertRaises(ValueError): run(request)

    def test_video_metadata_rejects_playlists_and_canonicalizes_source(self):
        with self.assertRaises(ValueError): video_metadata({'_type':'playlist','id':'abcdefghijk'})
        self.assertEqual(video_metadata({'id':'abcdefghijk','webpage_url':'https://youtube.com/shorts/abcdefghijk'})['webpage_url'],'https://www.youtube.com/watch?v=abcdefghijk')

    def test_avatar_download_rejects_untrusted_hosts(self):
        for url in ['http://yt3.googleusercontent.com/avatar','https://example.org/avatar','https://user@yt3.googleusercontent.com/avatar']:
            with self.assertRaises(ValueError): cache_avatar(url,'unused.jpg',7897)

    def test_browse_is_bounded_flat_and_keeps_older_videos(self):
        entries=[{'id':'abcdefghij'+str(i),'title':f'Video {i}','duration':61,'upload_date':'20050101'} for i in range(3)]
        request={'command':'browse','url':'@creator','node':'node','offset':30,'limit':2,'proxyPort':0}
        with patch('backend.workers.channel_monitor.YoutubeDL') as downloader:
            downloader.return_value.__enter__.return_value.extract_info.return_value={'channel_id':'UC1234567890123456789012','entries':iter(entries)}
            result=run(request)
            options=downloader.call_args.args[0]
            self.assertEqual((options['playliststart'],options['playlistend']),(31,33))
            self.assertEqual(options['extract_flat'],'in_playlist')
            self.assertEqual(options['proxy'],'')
            self.assertEqual(result['nextOffset'],32)
            self.assertEqual(len(result['videos']),2)
            self.assertEqual(result['videos'][0]['upload_date'],'20050101')
            self.assertTrue(result['videos'][0]['selectable'])
            self.assertEqual(downloader.return_value.__enter__.return_value.extract_info.call_count,1)

    def test_browse_marks_unavailable_videos_and_ends_pagination(self):
        entries=[{'id':'abcdefghijk','availability':'private'},{'id':'zzzzzzzzzzz','live_status':'is_upcoming'},None]
        with patch('backend.workers.channel_monitor.YoutubeDL') as downloader:
            downloader.return_value.__enter__.return_value.extract_info.return_value={'channel_id':'UC1234567890123456789012','entries':iter(entries)}
            result=run({'command':'browse','url':'@creator','node':'node'})
            self.assertIsNone(result['nextOffset'])
            self.assertEqual(len(result['videos']),2)
            self.assertTrue(all(not video['selectable'] for video in result['videos']))

    def test_browse_rejects_invalid_page_bounds(self):
        for values in [{'offset':-1},{'offset':10001},{'limit':0},{'limit':61},{'limit':True}]:
            with self.assertRaises(ValueError):run({'command':'browse','url':'@creator','node':'node',**values})

    def test_public_channel_operations_use_public_tab_api(self):
        cookie = object()
        info = {'channel_id': 'UC1234567890123456789012', 'channel': 'Creator',
                'entries': [{'id': 'abcdefghijk'}]}
        for command in ('resolve', 'profile', 'browse', 'scan'):
            with self.subTest(command=command), patch('backend.workers.channel_monitor.YoutubeDL') as downloader, patch(
                    'backend.workers.channel_monitor.youtube_options', return_value={'cookiefile': cookie}):
                downloader.return_value.__enter__.return_value.extract_info.return_value = info
                run({'command': command, 'url': '@creator', 'node': 'node', 'cursor': 'abcdefghijk'})
                options = downloader.call_args.args[0]
                self.assertEqual(options['extractor_args'], {'youtubetab': {'skip': ['authcheck']}})
                self.assertNotIn('cookiefile', options)
                self.assertEqual(options['proxy'], 'http://127.0.0.1:7897')

    def test_video_authentication_uses_normal_video_options(self):
        with patch('backend.workers.channel_monitor.YoutubeDL') as downloader:
            downloader.return_value.__enter__.return_value.extract_info.return_value = {'id': 'abcdefghijk'}
            run({'command': 'check', 'url': 'https://youtu.be/abcdefghijk', 'node': 'node'})
            self.assertNotIn('extractor_args', downloader.call_args.args[0])

    def test_handle_recovery_requires_exact_handle_and_fixed_channel_identity(self):
        from yt_dlp.utils import DownloadError
        identity = 'UC1234567890123456789012'
        for handle in ('@creator', '@different'):
            with self.subTest(handle=handle), patch('backend.workers.channel_monitor.YoutubeDL') as factory:
                downloader = factory.return_value.__enter__.return_value
                downloader.extract_info.side_effect = [
                    DownloadError('Failed to resolve url'),
                    {'entries': [{'uploader_id': handle, 'channel_id': identity}]},
                    {'channel_id': identity, 'channel': 'Creator', 'entries': []},
                ]
                if handle == '@different':
                    with self.assertRaisesRegex(ValueError, '无法确认'):
                        run({'command': 'resolve', 'url': '@creator', 'node': 'node'})
                    self.assertEqual(downloader.extract_info.call_count, 2)
                else:
                    result = run({'command': 'resolve', 'url': '@creator', 'node': 'node'})
                    self.assertEqual(result['channelId'], identity)
                    self.assertEqual(downloader.extract_info.call_args.args[0],
                                     'https://www.youtube.com/channel/' + identity + '/videos')

if __name__=='__main__': unittest.main()
