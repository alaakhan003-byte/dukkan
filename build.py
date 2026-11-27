#!/usr/bin/env python3
"""Builds the website from src/ into public/.
   python3 build.py                      → new version number from the clock
   python3 build.py --repo OWNER/REPO    → also sets the Windows download link
The app itself is src/shop.html — the same file that runs inside Claude."""
import json, re, sys, time, pathlib
R = pathlib.Path(__file__).resolve().parent
args = sys.argv[1:]
cfgp = R / 'site.config.json'
cfg = json.loads(cfgp.read_text()) if cfgp.exists() else {}
if '--repo' in args: cfg['repo'] = args[args.index('--repo') + 1]
if '--url' in args: cfg['url'] = args[args.index('--url') + 1].rstrip('/')
cfg.setdefault('repo', 'OWNER/REPO'); cfg.setdefault('url', '')
cfgp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n')
version = time.strftime('%Y.%m.%d-%H%M', time.gmtime())
pub = R / 'public' / 'app'

app = (R / 'src' / 'shop.html').read_text(encoding='utf-8')
head = f'''<link rel="manifest" href="manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="دكّان">
<meta name="application-name" content="دكّان">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<script src="site.js?v={version}"></script>
'''
marker = '<meta charset="UTF-8">\n'
assert app.count(marker) == 1, 'charset marker missing'
app = app.replace(marker, marker + head)
app = re.sub(r'<meta name="theme-color" content="[^"]*">', '<meta name="theme-color" content="#312E81">', app, count=1)
(pub / 'index.html').write_text(app, encoding='utf-8')
for n in ['site.js', 'sw.js']:
    (pub / n).write_text((R / 'src' / n).read_text(encoding='utf-8').replace('__VERSION__', version), encoding='utf-8')
exe = f"https://github.com/{cfg['repo']}/releases/latest/download/Dukkan-Setup.exe"
(pub / 'version.json').write_text(json.dumps({'version': version, 'exe': exe, 'repo': cfg['repo']}, ensure_ascii=False, indent=2) + '\n')
land = (R / 'src' / 'landing.html').read_text(encoding='utf-8').replace('__VERSION__', version).replace('__EXE__', exe).replace('__REPO__', cfg['repo'])
(R / 'public' / 'index.html').write_text(land, encoding='utf-8')
if cfg['url']:
    (R / 'desktop' / 'config.json').write_text(json.dumps({'url': cfg['url'] + '/app/'}, indent=2) + '\n')
print('built', version, '| exe:', exe)
