import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.workers.youtube_auth import save


def main():
    try:
        payload = json.load(sys.stdin.buffer)
        data = Path(os.environ['APPDATA']) / 'YouDub2bi' / 'harness' / 'youdub'
        save(payload['cookies'], data, only_changed=True)
    except Exception:
        print('{"ok":false}')
        return 1
    print('{"ok":true}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
