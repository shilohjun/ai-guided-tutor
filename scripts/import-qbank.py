"""Import an offline bank as data; never execute its JavaScript. Python stdlib only."""
import argparse, collections, copy, hashlib, html, json, re
from html.parser import HTMLParser
from pathlib import Path

VOID = {'img','br','hr','input','meta','link','source','wbr','area','base','col','embed','param','track'}
ALLOWED = {'p','div','span','img','br','strong','b','em','i','u','sub','sup','table','thead','tbody','tr','th','td','ul','ol','li'}

class Node:
    def __init__(self, tag='', attrs=()): self.tag=tag; self.attrs=dict(attrs); self.children=[]
    def find(self, cls):
        if cls in self.attrs.get('class','').split(): return self
        return next((found for child in self.children if isinstance(child,Node) and (found:=child.find(cls))), None)
    def text(self):
        if self.tag=='img': return '〔式〕' if 'f' in self.attrs.get('class','').split() else '〔图〕'
        return re.sub(r'\s+',' ', ' '.join(x.text() if isinstance(x,Node) else x for x in self.children)).strip()
    def render(self, images):
        inside=''.join(x.render(images) if isinstance(x,Node) else html.escape(x,quote=False) for x in self.children)
        if self.tag not in ALLOWED: return '' if self.tag in {'script','style','iframe','object'} else inside
        attrs={k:v for k,v in self.attrs.items() if k in {'class','width','height','alt','colspan','rowspan','data-k','src'}}
        if self.tag=='img':
            key=attrs.get('data-k'); src=attrs.get('src') or images.get(key)
            if not src or not re.match(r'^data:image/(?:webp|png|jpeg|gif|svg\+xml);base64,',src): raise ValueError(f'Missing/unsafe image {key}')
            attrs['src']=src
            attrs['class']='qf' if 'f' in self.attrs.get('class','').split() else 'qfig'
        tag='<'+self.tag+''.join(' '+k+'="'+html.escape(str(v or ''),quote=True)+'"' for k,v in attrs.items())+'>'
        return tag if self.tag in VOID else tag+inside+'</'+self.tag+'>'
    def inner(self,images): return ''.join(x.render(images) if isinstance(x,Node) else html.escape(x,quote=False) for x in self.children)

class ArticleParser(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.root=Node(); self.stack=[self.root]
    def handle_starttag(self,tag,attrs):
        n=Node(tag,attrs);self.stack[-1].children.append(n)
        if tag not in VOID:self.stack.append(n)
    def handle_startendtag(self,tag,attrs): self.handle_starttag(tag,attrs); self.handle_endtag(tag)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag:self.stack=self.stack[:i];break
    def handle_data(self,data):self.stack[-1].children.append(data)

def js_data(path, export):
    s=path.read_text(encoding='utf-8-sig');start=s.index('=',s.index('export const '+export))+1
    return json.JSONDecoder().raw_decode(s[start:].lstrip())[0]

def import_bank(source,root):
    raw=source.read_bytes(); s=raw.decode('utf-8-sig');dec=json.JSONDecoder()
    def data(pattern):
        m=re.search(pattern,s);assert m,pattern
        return dec.raw_decode(s[m.end():].lstrip())[0]
    kg=data(r'\bvar KG\s*='); th=data(r',\s*TH\s*=');images=data(r'\bvar IMG\s*=')
    # Two source articles use k78, which is absent from the source's displayed graph.
    # Restore its explicit subject/chapter association rather than dropping either question.
    source_ids={l['id'] for m in kg for c in m['children'] for l in c['children']}
    taxonomy_repairs=[]
    if 'k78' not in source_ids and re.search(r'data-kg="[^"]*\bk78\b',s):
        experiment=next(m for m in kg if m['name']=='实验')
        chapter={'id':'c-实验-热学实验','name':'热学实验','count':2,
                 'children':[{'id':'k78','name':'气体等温变化','count':2}]}
        experiment['children'].append(chapter)
        taxonomy_repairs.append({'id':'k78','reason':'Referenced by source articles but absent from source KG; restored using the previous bank taxonomy 气体等温变化 under 实验/热学实验.'})
    # Some source questions only identify a chapter. Keep that honest scope in reports.
    source_leaf_ids={l['id'] for m in kg for c in m['children'] for l in c['children']}
    chapter_fallbacks={}
    for match in re.finditer(r'<article\b[^>]*>',s):
        parser=ArticleParser();parser.feed(match[0]);a=parser.root.children[0].attrs
        ids=a.get('data-kg','').split()
        if not any(i in source_leaf_ids for i in ids):
            chapter_id=next((i for i in ids if i.startswith('c-')),None)
            assert chapter_id,('No source chapter',a['id'])
            chapter=next(c for m in kg for c in m['children'] if c['id']==chapter_id)
            if chapter_id not in chapter_fallbacks:
                leaf_id='chapter-review-'+chapter_id
                chapter_fallbacks[chapter_id]=leaf_id
                chapter['children'].append({'id':leaf_id,'name':'章节复习（原题未细分）','count':0})
                taxonomy_repairs.append({'id':leaf_id,'reason':'Source question has chapter tags only; report remains chapter-level, not an inferred specific concept.'})
    old=js_data(root/'src/core/qbank-source.data.js','QBANK_SOURCE')
    oldgraphs=js_data(root/'src/core/qbank-graphs.data.js','QBANK_GRAPHS')
    # Preserve semantic identity even when source ordering or synthetic kx IDs change.
    oldpaths={(m['name'],c['name'],l['name']):l['id'] for m in oldgraphs['knowledge'] for c in m['children'] for l in c['children']}
    used=set(oldpaths.values()); translation={};next_extra=1
    for mod in kg:
        for chapter in mod['children']:
            for leaf in chapter['children']:
                source_id=leaf['id'];path=(mod['name'],chapter['name'],leaf['name'])
                stable=oldpaths.get(path,source_id)
                if path not in oldpaths and stable in used:
                    while f'kbank{next_extra}' in used:next_extra+=1
                    stable=f'kbank{next_extra}'
                translation[source_id]=stable;leaf['id']=stable;used.add(stable)
    klookup={l['id']:(m['name'],c['name'],l['name']) for m in kg for c in m['children'] for l in c['children']}
    tlookup={l['id']:(f['name'],l['name']) for f in th for l in [f,*f['children']]}
    records=[]
    for match in re.finditer(r'<article\b[^>]*>.*?</article>',s,re.S):
        parser=ArticleParser();parser.feed(match[0]);a=parser.root.children[0];attrs=a.attrs
        def node(name):
            n=a.find(name)
            if n is None:raise ValueError(f'{attrs.get("id")}: missing {name}')
            return n
        kids=[translation[i] for i in attrs.get('data-kg','').split() if i in translation]
        if not kids:
            chapter_id=next(i for i in attrs['data-kg'].split() if i in chapter_fallbacks)
            kids=[translation[chapter_fallbacks[chapter_id]]]
        tids=attrs.get('data-think','').split(); mids=[i for i in tids if re.fullmatch(r't\d+[a-z]',i)] or [i for i in tids if i in tlookup]
        assert kids and mids,attrs.get('id')
        opts=node('options') if a.find('options') else Node()
        options=[{'l':n.find('ol').text(),'html':n.find('oc').inner(images),'text':n.find('oc').text()} for n in opts.children if isinstance(n,Node) and n.find('oc')]
        src=node('q-source'); stem=node('stem');answer=node('ansval');analysis=node('analysis')
        tagpaths=[klookup[k] for k in kids]
        record={'sourceIndex':int(attrs['id'][1:]),'code':node('q-id').text(),'no':node('q-index').text(),
            'ty':attrs['data-type'],'d':attrs['data-difficulty'],'p':attrs['data-province'],
            'year':attrs.get('data-year',''),'mod':attrs['data-module'],'chap':tagpaths[0][1], 'leaf':tagpaths[0][2],
            't1':tlookup[mids[0]][0],'t2':tlookup[mids[0]][1],'src':src.text(),
            'stemHtml':stem.inner(images),'stemText':stem.text(),'options':options,
            'answerHtml':answer.inner(images),'answerText':answer.text(),'analysisHtml':analysis.inner(images),'analysisText':analysis.text(),
            'nF':sum('f' in x.attrs.get('class','').split() for x in all_nodes(a) if x.tag=='img'),
            'nFig':sum('f' not in x.attrs.get('class','').split() for x in all_nodes(a) if x.tag=='img'),
            'knowledgeIds':kids,'methodIds':mids}
        record['sourceKnowledgeIds']=attrs['data-kg'].split()
        record['sourceMethodIds']=attrs['data-think'].split()
        assert record['stemText'] and record['answerHtml'].strip() and record['analysisHtml'].strip(),record['code']
        records.append(record)
    bycode=collections.defaultdict(list)
    for record in records:bycode[record['code']].append(record)
    preserved=[]
    for q in old:
        choices=[r for r in bycode[q['code']] if 'i' not in r]
        if len(choices)>1:
            exact=[r for r in choices if r['stemHtml']==q['stemHtml'] and r['options']==q['options']]
            if exact:choices=exact
            else:choices=[r for r in choices if re.sub(r'\s+','',r['stemText'])==re.sub(r'\s+','',q['stemText'])]
        if len(choices)>1 and len({(r['stemHtml'],json.dumps(r['options'],ensure_ascii=False)) for r in choices})==1:
            same_index=[r for r in choices if r['sourceIndex']==q.get('sourceIndex')]
            if len(same_index)==1:choices=same_index
        assert len(choices)==1,('Cannot safely preserve old identity',q['i'],q['code'])
        choices[0]['i']=q['i'];preserved.append({'i':q['i'],'code':q['code']})
    next_id=max(q['i'] for q in old)+1
    for record in records:
        if 'i' not in record:record['i']=next_id;next_id+=1
    records.sort(key=lambda q:q['i'])
    assert len(records)==len({r['i'] for r in records}) and len(records)>0
    # Finish all validation before replacing generated files.
    meta=[];folder=root/'public/qbank/q';folder.mkdir(parents=True,exist_ok=True)
    for q in records:
        public={k:v for k,v in q.items() if k not in {'answerHtml','answerText','analysisHtml','analysisText'}}
        (folder/f'{q["i"]}.json').write_text(json.dumps(public,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
        meta.append({'i':q['i'],'code':q['code'],'sourceIndex':q['sourceIndex'],
            'm':q['mod'],'k':next(c['id'] for m in kg for c in m['children'] if any(l['id']==q['knowledgeIds'][0] for l in c['children'])),
            'l':q['knowledgeIds'][0],'t':re.match(r't\d+',q['methodIds'][0])[0], 't2':q['methodIds'][0],
            'ty':q['ty'],'d':{'易':2,'中':3,'难':4}[q['d']],'p':q['p'],'year':q['year'],
            's':q['stemText'][:160],'stem':q['stemText'],'opt':' '.join(o['l']+'. '+o['text'] for o in q['options']),
            'knowledgeIds':q['knowledgeIds'],'methodIds':q['methodIds']})
    dump=lambda obj:json.dumps(obj,ensure_ascii=False,separators=(',',':'))
    index={'kg':kg,'think':th,'qs':meta}
    (root/'public/qbank/data.json').write_text(dump(index),encoding='utf-8')
    mapfile=root/'public/qbank/map.html';maphtml=mapfile.read_text(encoding='utf-8')
    replacement=dump(index).replace('<','\\u003c')
    maphtml,n=re.subn(r'(<script type="application/json" id="qdata">).*?(</script>)',lambda m:m[1]+replacement+m[2],maphtml,count=1,flags=re.S)
    assert n==1
    mapfile.write_text(maphtml,encoding='utf-8')
    (root/'src/core/qbank-source.data.js').write_text('// Generated data; reference answers are server-only.\nexport const QBANK_SOURCE = '+dump(records)+';\n',encoding='utf-8')
    (root/'src/core/qbank-graphs.data.js').write_text('// Source taxonomies with stable semantic IDs.\nexport const QBANK_GRAPHS = '+dump({'knowledge':kg,'methods':th})+';\n',encoding='utf-8')
    manifest={'questions':len(records),'previousQuestions':len(old),'addedQuestions':len(records)-len(old),
        'sourceSha256':hashlib.sha256(raw).hexdigest(),'knowledgeLeaves':len(klookup),
        'methodLeaves':sum(len(f['children']) for f in th),'preservedQuestionIds':preserved,
        'sourceKnowledgeIdMap':translation,'duplicateSourceCodes':[k for k,v in bycode.items() if len(v)>1],
        'taxonomyRepairs':taxonomy_repairs,
        'formulaHandling':'Original formula and figure images preserved; no OCR claim.'}
    (root/'docs/qbank-import-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in manifest.items() if k not in {'preservedQuestionIds','sourceKnowledgeIdMap'}},ensure_ascii=False))

def all_nodes(node):
    yield node
    for child in node.children:
        if isinstance(child,Node):yield from all_nodes(child)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    args=parser.parse_args();import_bank(args.source,args.root)
