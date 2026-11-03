#!/usr/bin/env python3
"""Synthetic anchor sanity test; NOT a substitute for compiling an actual IRMIA checkout."""
from __future__ import annotations
from pathlib import Path
from tempfile import TemporaryDirectory
from subprocess import run
import ast
import sys

script=Path(__file__).with_name('generate_full_versions.py')
code=script.read_text('utf-8')
module=ast.parse(code)
func=next(x for x in module.body if isinstance(x,ast.FunctionDef) and x.name=='apply')
branches=[]
node=next(x for x in func.body if isinstance(x,ast.If))
while True:
 expr=node.test
 assert isinstance(expr,ast.Compare) and isinstance(expr.comparators[0],ast.Constant)
 path=expr.comparators[0].value
 anchors=[]
 for stmt in node.body:
  if isinstance(stmt,ast.Assign) and isinstance(stmt.value,ast.Call):
   call=stmt.value
   if isinstance(call.func,ast.Name) and call.func.id=='once' and len(call.args)>1 and isinstance(call.args[1],ast.Constant):
    anchors.append(call.args[1].value)
 if not isinstance(path,str): raise AssertionError(path)
 branches.append((path,anchors))
 if not node.orelse or not isinstance(node.orelse[0],ast.If):break
 node=node.orelse[0]

versions={
 'src/state/projection-cache.ts':"export const PROJECTION_CACHE_VERSION = 2;\n",
 'src/state/snapshot.ts':"export const SNAPSHOT_VERSION = 2;\n",
 'src/model/render.ts':"export const RENDER_VERSION = '80';\n",
}
with TemporaryDirectory(prefix='affect-generator-smoke-') as d:
 root=Path(d)/'source';out=Path(d)/'out'
 for path,anchors in branches:
  p=root/path;p.parent.mkdir(parents=True,exist_ok=True)
  # Longer anchors subsume shorter fragments. All unique anchors must be present exactly once.
  selected=[]
  for a in sorted(set(anchors),key=len,reverse=True):
   if not any(a in existing for existing in selected):selected.append(a)
  p.write_text(versions.get(path,'')+'\n\n'.join(selected)+'\n','utf8')
 process=run([sys.executable,str(script),'--repo',str(root),'--out',str(out)],capture_output=True,text=True)
 if process.returncode:
  print(process.stderr or process.stdout,file=sys.stderr)
  sys.exit(process.returncode)
 assert len(list(out.rglob('*.ts')))==8
 assert 'affectEvaluation?: true' in (out/'src/log/types.ts').read_text(encoding='utf-8')
 assert 'd.affectEvaluation !== true' in (out/'src/state/fold.ts').read_text(encoding='utf-8')
 assert 'NOW_LABEL.affect' in (out/'src/model/render.ts').read_text(encoding='utf-8')
 assert 'trustForWake' in (out/'src/runtime/real-loop.ts').read_text(encoding='utf-8')
 rendered=(out/'src/model/render.ts').read_text(encoding='utf-8')
 # Ensure newline-safe TS template string; quoting bug was caught here.
 assert 'const AFFECT_STATIC_RULES = `\\n' in rendered
 assert '施压维持联系。`;' in rendered
 print('Synthetic generator anchors: 8/8 complete files; source checkout unmodified; code shape OK')
