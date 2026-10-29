"""Build a legacy read-only client without packaging scraper/test/dependency sources."""
from pathlib import Path
import shutil
root=Path.cwd();out=root/'_site'
if out.exists():shutil.rmtree(out)
out.mkdir()
extensions={'.html','.js','.css','.json','.xml','.svg','.png','.jpg','.webp','.ico','.woff','.woff2','.webmanifest'}
for p in root.iterdir():
    if p.is_file() and p.suffix in extensions:shutil.copy2(p,out/p.name)
for name in ('data','config','assets','images','fonts'):
    p=root/name
    if p.exists():shutil.copytree(p,out/name,ignore=shutil.ignore_patterns('__pycache__','node_modules'))
(out/'.nojekyll').touch()
size=sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
assert size<30*1024**2,f'Legacy client bundle unexpectedly large: {size}'
assert (out/'index.html').exists()
print(f'Canonical client bundle: {size} bytes')
