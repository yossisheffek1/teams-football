# Builds index.html from src/app.js + src/style.css.  Run from the repo root:  python3 build.py
import os
ROOT=os.path.dirname(os.path.abspath(__file__))
css=open(os.path.join(ROOT,'src','style.css')).read(); js=open(os.path.join(ROOT,'src','app.js')).read()
html=f"""<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>כדורגל שבועי ⚽</title>
<meta name="theme-color" content="#11161d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="כדורגל">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.json">
<link rel="icon" type="image/png" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta property="og:title" content="⚽ הרשמה לכדורגל השבועי">
<meta property="og:description" content="כל הקודם זוכה, נרשמים בלחיצה">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&display=swap" rel="stylesheet">
<style>{css}</style>
</head>
<body>
<header><div class="hin" id="hdr"><h1>⚽ כדורגל שבועי</h1></div></header>
<div class="wrap">
  <nav><div class="tabs" id="tabs"></div></nav>
  <main id="main"><div class="loading">טוען…</div></main>
</div>
<div class="toast" id="toast"></div>
<script type="module">
{js}
</script>
</body>
</html>
"""
open(os.path.join(ROOT,'index.html'),'w').write(html)
print('built index.html')
