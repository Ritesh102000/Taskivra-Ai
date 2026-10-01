#!/usr/bin/env python3
"""Build the same beginner content into a navigable PDF and static HTML.

Requires reportlab. Set TASKIVRA_FONT_DIR to a directory containing DejaVuSans,
DejaVuSans-Bold, and DejaVuSansMono TTF files if automatic discovery fails.
"""
from __future__ import annotations
import argparse
import html
import json
import os
from pathlib import Path
import re
import shutil
import textwrap
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, StyleSheet1
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Flowable, Frame,
    PageBreak, PageTemplate, Paragraph, Preformatted, Spacer, Table, TableStyle)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[1]
INK = colors.HexColor('#233631')
TEAL = colors.HexColor('#174e46')
MUTED = colors.HexColor('#5f6f67')
SOFT = colors.HexColor('#eef3e9')
LINE = colors.HexColor('#dce2d9')
W, H = A4
MARGIN = 48
BODY_WIDTH = W - 2*MARGIN


def clean(value):
    if isinstance(value, str):
        return value.translate(str.maketrans({'\u2014':' - ', '\u2013':'-', '\u2011':'-', '\u2019':"'", '\u2018':"'", '\u201c':'"', '\u201d':'"', '\u2192':' > ', '\u00a0':' '})).replace('Settings > Model connections','Settings > Models and providers')
    if isinstance(value, list): return [clean(x) for x in value]
    if isinstance(value, dict): return {k:clean(v) for k,v in value.items()}
    return value


def slug(value):
    return re.sub(r'[^a-z0-9]+','-',value.lower()).strip('-')


def case_section(case):
    blocks = [
        {'type':'note','title':'Before following this example','text':case['promptLabel']},
        {'type':'heading','text':'What you need'},
        {'type':'list','items':case['needs']},
        {'type':'heading','text':'Create this agent'},
        {'type':'p','text':f"Agent name: {case['agentName']}"},
        {'type':'p','text':'Copy or adapt these reusable agent instructions:'},
        {'type':'code','text':case['agentInstructions']},
    ]
    if case.get('agentSetupNote'): blocks.append({'type':'note','title':'Agent setup distinction','text':case['agentSetupNote']})
    blocks += [
        {'type':'heading','text':'The job and definition of done'},
        {'type':'p','text':'Example objective:'},
        {'type':'code','text':case['objective']},
        {'type':'p','text':'What a useful completed result should contain:'},
        {'type':'p','text':case['doneLooksLike']},
    ]
    if case.get('values'):
        blocks.append({'type':'heading','text':'Example inputs to enter'})
        blocks.append({'type':'p','text':'Use the fields named in the steps below. These are example values to adapt, not an automatically configured or completed task.'})
        for key,value in case['values'].items():
            label={'focus':'Focus / review question','websites':'Approved pages, one per line','question':'Analysis question','files':'What the files represent','account':'Your exact Gmail address','objective':'Fleet objective','projectName':'New project name','projectDescription':'Project description','preparationObjective':'Evidence-preparer task objective','preparationDoneLooksLike':'What done looks like for the preparation task','mode':'Fleet mode','evidenceFilenames':'Example evidence filenames - supply your own copies'}.get(key,key)
            if isinstance(value,list):value='\n'.join(str(x) for x in value)
            elif isinstance(value,dict):value='\n'.join(f'{k}: {v}' for k,v in value.items())
            blocks.extend([{'type':'p','text':label+':'},{'type':'code','text':value}])
    blocks += [
        {'type':'heading','text':'Follow the steps'},
        {'type':'steps','items':case['steps']},
        {'type':'heading','text':'Check the finished result'},
        {'type':'list','items':case['review']},
        {'type':'note','title':'Scope and limitations','text':case['limitsNote']},
    ]
    return {'id':case['id'],'title':case['title'],'summary':case['summary'],'group':'Step-by-step examples','blocks':blocks}


def load_guide():
    core=clean(json.loads((ROOT/'docs/guide/guide-content.json').read_text()))
    cases=clean(json.loads((ROOT/'docs/guide/use-cases.json').read_text()))
    core['sections'] += [case_section(x) for x in cases]
    core['sections'].append(core.pop('referenceSection'))
    ids=set()
    for section in core['sections']:
        if section['id'] in ids:raise ValueError('Duplicate chapter ID')
        ids.add(section['id'])
        count=0
        for block in section['blocks']:
            if block['type']=='heading':
                count+=1;block['id']=section['id']+'-'+str(count)+'-'+slug(block['text'])
                ids.add(block['id'])
    for target in re.findall(r'href="#([^"]+)"',json.dumps(core)):
        if target not in ids:raise ValueError('Unknown link destination: '+target)
    return core


def markup(text):
    """Escape prose, retaining only intentional plain anchor links."""
    parts=[];pos=0
    for match in re.finditer(r'<a href="([^"]+)">([^<]+)</a>',text):
        parts.append(html.escape(text[pos:match.start()]))
        parts.append(f'<link href="{html.escape(match[1],quote=True)}" color="#174e46"><u>{html.escape(match[2])}</u></link>')
        pos=match.end()
    parts.append(html.escape(text[pos:]))
    return ''.join(parts)


def register_fonts():
    cache=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies'
    candidates=[Path(os.environ['TASKIVRA_FONT_DIR'])] if os.environ.get('TASKIVRA_FONT_DIR') else []
    candidates += [cache/'native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype',Path('/usr/share/fonts/truetype/dejavu'),Path('/Library/Fonts')]
    chosen=next((p for p in candidates if all((p/name).is_file() for name in ['DejaVuSans.ttf','DejaVuSans-Bold.ttf','DejaVuSansMono.ttf'])),None)
    if chosen is None:raise RuntimeError('Set TASKIVRA_FONT_DIR to your DejaVu font folder. No font download was attempted.')
    for label,filename in [('Guide','DejaVuSans.ttf'),('GuideBold','DejaVuSans-Bold.ttf'),('GuideMono','DejaVuSansMono.ttf')]:
        pdfmetrics.registerFont(TTFont(label,str(chosen/filename)))
    pdfmetrics.registerFontFamily('Guide',normal='Guide',bold='GuideBold',italic='Guide',boldItalic='GuideBold')


def styles():
    s=StyleSheet1()
    definitions=[
      ('Body','Guide',10.6,15.5,INK,0,7),
      ('Small','Guide',8.7,13,MUTED,0,7),
      ('ChapterTitle','GuideBold',24,29,TEAL,0,12),
      ('SectionTitle','GuideBold',13,18,INK,13,7),
      ('Eyebrow','GuideBold',8.5,12,TEAL,0,10),
      ('Summary','Guide',11.5,17,MUTED,0,12),
      ('Cell','Guide',9.1,13,INK,0,0),
      ('CellHeader','GuideBold',9.1,13,TEAL,0,0),
      ('Note','Guide',9.6,14.6,INK,0,0),
      ('Step','Guide',10.6,16,INK,0,0),
      ('TOC','Guide',10,14,INK,0,5),
      ('Code','GuideMono',8.7,13,TEAL,0,0),
    ]
    for name,font,size,leading,color,before,after in definitions:
        s.add(ParagraphStyle(name,fontName=font,fontSize=size,leading=leading,textColor=color,spaceBefore=before,spaceAfter=after,alignment=TA_LEFT,allowWidows=0,allowOrphans=0,keepWithNext=name in ['ChapterTitle','SectionTitle','Eyebrow']))
    return s


class Cover(Flowable):
    def __init__(self,guide,s): super().__init__();self.guide=guide;self.s=s;self.width=BODY_WIDTH;self.height=H-146
    def draw(self):
        c=self.canv;top=self.height-30
        c.setFillColor(TEAL)
        for x,y in [(0,0),(20,0),(10,-20)]:c.roundRect(x,top+y,12,12,3,fill=1,stroke=0)
        c.setFont('GuideBold',11);c.drawString(49,top+1,'TASKIVRA AI')
        c.setFont('Guide',9);c.setFillColor(MUTED);c.drawString(0,top-69,'ONE OBJECTIVE. YOUR AGENTS, WORKING TOGETHER.')
        c.setFillColor(TEAL);c.setFont('GuideBold',38)
        c.drawString(0,top-133,'The complete')
        c.drawString(0,top-181,'beginner guide')
        y=top-218
        intro=Paragraph('Start from zero. Understand the product, prepare your Mac, create your agents, and follow eight practical use cases one step at a time.',self.s['Summary'])
        w,h=intro.wrap(BODY_WIDTH-28,100);intro.drawOn(c,0,y-h)
        y-=h+38
        c.setStrokeColor(LINE);c.line(0,y,BODY_WIDTH,y)
        y-=36
        for label,text in [('01','Understand the ideas and the screens'),('02','Set up models, browsers, files, and accounts'),('03','Create an agent and run your first task'),('04','Try eight worked use-case walkthroughs')]:
            c.setFillColor(TEAL);c.setFont('GuideBold',10);c.drawString(0,y,label)
            c.setFillColor(INK);c.setFont('Guide',10.5);c.drawString(32,y,text);y-=29
        y-=19
        box=Paragraph('<b>Local desktop pre-release, version '+self.guide['version']+'.</b><br/>The current app opens as Agent Workspaces. The online guide is documentation, not a cloud version of the app. Examples are instructional, not completed live runs.',self.s['Note'])
        _,bh=box.wrap(BODY_WIDTH-30,180)
        c.setFillColor(SOFT);c.roundRect(0,y-bh-25,BODY_WIDTH,bh+25,9,fill=1,stroke=0);box.drawOn(c,15,y-bh-12)
        c.setFont('Guide',9);c.setFillColor(MUTED);c.drawString(0,23,'Guide edition: '+self.guide['date'])
        c.setFillColor(TEAL);c.drawRightString(BODY_WIDTH,23,'Linked contents and PDF bookmarks')


class GuideDoc(BaseDocTemplate):
    def __init__(self,path,guide):
        super().__init__(str(path),pagesize=A4,leftMargin=MARGIN,rightMargin=MARGIN,topMargin=59,bottomMargin=52,title='Taskivra AI - The complete beginner guide',author='Taskivra AI',subject='Mac desktop setup and eight step-by-step agent use cases')
        self.guide=guide;self.chapter='Beginner guide'
        self.addPageTemplates(PageTemplate(id='guide',frames=[Frame(MARGIN,52,BODY_WIDTH,H-111,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=self.page))
    def page(self,c,doc):
        c.saveState()
        c.setTitle('Taskivra AI - The complete beginner guide')
        c.setAuthor('Taskivra AI');c.setSubject('Version '+self.guide['version']+' - '+self.guide['date'])
        c.showOutline()
        if doc.page>1:
            c.setStrokeColor(LINE);c.setLineWidth(.6);c.line(MARGIN,H-38,W-MARGIN,H-38)
            c.setFont('GuideBold',8);c.setFillColor(TEAL);c.drawString(MARGIN,H-29,'TASKIVRA AI / BEGINNER GUIDE')
            c.setFont('Guide',8);c.setFillColor(MUTED);c.drawRightString(W-MARGIN,H-29,'0.9.9 / LOCAL PRE-RELEASE')
            c.setStrokeColor(LINE);c.line(MARGIN,37,W-MARGIN,37)
            c.setFont('Guide',8);c.setFillColor(TEAL);c.drawString(MARGIN,24,'Contents')
            c.linkRect('', 'contents',(MARGIN-2,20,MARGIN+43,34),relative=0,thickness=0)
            c.setFillColor(MUTED);c.drawCentredString(W/2,24,self.guide['date']);c.drawRightString(W-MARGIN,24,'Page '+str(doc.page))
        c.restoreState()
    def afterFlowable(self,f):
        if isinstance(f,Paragraph) and hasattr(f,'guideKey'):
            key=f.guideKey;level=getattr(f,'outlineLevel',0)
            self.canv.bookmarkPage(key,fit='XYZ',left=0,top=self.frame._y+f.height,zoom=0)
            self.canv.addOutlineEntry(f.getPlainText(),key,level=level,closed=level==0)
            if getattr(f,'tocEntry',False):self.notify('TOCEntry',(0,f.getPlainText(),self.page,key))


def pdf_build(guide,path):
    register_fonts();s=styles();doc=GuideDoc(path,guide)
    flow=[Cover(guide,s),PageBreak()]
    title=Paragraph('Contents',s['ChapterTitle']);title.guideKey='contents';title.outlineLevel=0
    flow += [title,Paragraph('Click a chapter to jump to it. Within each chapter, use the linked subsection list. Open your PDF viewer\'s bookmarks for the complete chapter/subsection outline.',s['Body'])]
    toc=TableOfContents();toc.levelStyles=[s['TOC']];toc.dotsMinLevel=0
    flow += [toc,Spacer(1,12),Paragraph('Examples start with creating a helper and continue through inputs, limits, running, waiting, and reviewing the exact output. No prior project knowledge is assumed.',s['Small']),PageBreak()]
    for number,section in enumerate(guide['sections'],1):
        flow.append(Paragraph(f"CHAPTER {number:02d} / {html.escape(section['group'].upper())}",s['Eyebrow']))
        title=Paragraph(html.escape(section['title']),s['ChapterTitle']);title.guideKey=section['id'];title.outlineLevel=0;title.tocEntry=True
        flow += [title,Paragraph(markup(section['summary']),s['Summary'])]
        headings=[x for x in section['blocks'] if x['type']=='heading']
        if headings:
            quick=' &nbsp; / &nbsp; '.join(f'<link href="#{x["id"]}" color="#174e46"><u>{html.escape(x["text"])}</u></link>' for x in headings)
            flow += [Paragraph('IN THIS CHAPTER',s['Eyebrow']),Paragraph(quick,s['Small']),Spacer(1,7)]
        for block in section['blocks']:
            kind=block['type']
            if kind=='heading':
                if block.get('pageBreakBefore'): flow.append(PageBreak())
                v=Paragraph(html.escape(block['text']),s['SectionTitle']);v.guideKey=block['id'];v.outlineLevel=1;flow.append(v)
            elif kind=='p':flow.append(Paragraph(markup(block['text']),s['Body']))
            elif kind=='list':
                for text in block['items']:
                    flow.append(Table([[Paragraph('•',s['Body']),Paragraph(markup(text),s['Body'])]],colWidths=[15,BODY_WIDTH-15],style=TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),1)])))
            elif kind=='steps':
                for i,item in enumerate(block['items'],1):
                    title=Paragraph(f'{i:02d}',s['Eyebrow'])
                    body=Paragraph('<b>'+html.escape(item['title'])+'</b><br/>'+markup(item['text']),s['Step'])
                    flow.append(Table([[title,body]],colWidths=[29,BODY_WIDTH-29],style=TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),2),('BOTTOMPADDING',(0,0),(-1,-1),8)])))
            elif kind=='note':
                v=Paragraph('<b>'+html.escape(block['title'])+'</b><br/>'+markup(block['text']),s['Note'])
                flow += [Spacer(1,4),Table([[v]],colWidths=[BODY_WIDTH],style=TableStyle([('BACKGROUND',(0,0),(-1,-1),SOFT),('BOX',(0,0),(-1,-1),.5,LINE),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),11),('BOTTOMPADDING',(0,0),(-1,-1),11)])),Spacer(1,11)]
            elif kind=='code':
                wrapped='\n'.join('\n'.join(textwrap.wrap(line,width=81,break_long_words=True,break_on_hyphens=False,replace_whitespace=False) or ['']) for line in block['text'].splitlines())
                v=Preformatted(wrapped,s['Code'])
                flow += [Table([[v]],colWidths=[BODY_WIDTH],style=TableStyle([('BACKGROUND',(0,0),(-1,-1),SOFT),('LEFTPADDING',(0,0),(-1,-1),11),('RIGHTPADDING',(0,0),(-1,-1),11),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)])),Spacer(1,11)]
            elif kind=='table':
                n=len(block['headers']);widths=([BODY_WIDTH*.31,BODY_WIDTH*.69] if n==2 else [BODY_WIDTH*.26,BODY_WIDTH*.39,BODY_WIDTH*.35])
                rows=[[Paragraph(html.escape(x),s['CellHeader']) for x in block['headers']]]
                rows += [[Paragraph(markup(str(x)),s['Cell']) for x in row] for row in block['rows']]
                flow += [Table(rows,colWidths=widths,repeatRows=1,hAlign='LEFT',style=TableStyle([('BACKGROUND',(0,0),(-1,0),SOFT),('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,-1),.5,LINE),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)])),Spacer(1,11)]
            else:raise ValueError('Unknown guide block: '+kind)
        if number<len(guide['sections']):
            flow.extend([Spacer(1,25),CondPageBreak(265)])
    doc.multiBuild(flow,maxPasses=5)


def html_build(guide):
    sections=[];nav=[]
    for i,section in enumerate(guide['sections'],1):
        nav.append(f'<li><a href="#{section["id"]}"><span class="nav-number">{i:02d}</span> {html.escape(section["title"])}</a></li>')
        out=[f'<section id="{section["id"]}" aria-labelledby="title-{section["id"]}">',f'<h2 id="title-{section["id"]}"><span class="chapter-number">CHAPTER {i:02d} / {html.escape(section["group"].upper())}</span>{html.escape(section["title"])}</h2>',f'<p class="chapter-summary">{html.escape(section["summary"])}</p>']
        heads=[x for x in section['blocks'] if x['type']=='heading']
        if heads:out.append('<nav class="chapter-jumps" aria-label="In this chapter">'+ ' · '.join(f'<a href="#{b["id"]}">{html.escape(b["text"])}</a>' for b in heads)+'</nav>')
        for b in section['blocks']:
            kind=b['type']
            if kind=='heading':out.append(f'<h3 id="{b["id"]}">{html.escape(b["text"])}</h3>')
            elif kind=='p':out.append('<p>'+b['text']+'</p>')
            elif kind=='list':out.append('<ul>'+''.join('<li>'+x+'</li>' for x in b['items'])+'</ul>')
            elif kind=='steps':out.append('<ol class="steps">'+''.join('<li><p><strong>'+html.escape(x['title'])+'</strong></p><p>'+x['text']+'</p></li>' for x in b['items'])+'</ol>')
            elif kind=='note':out.append('<aside class="note"><p><strong>'+html.escape(b['title'])+'</strong></p><p>'+b['text']+'</p></aside>')
            elif kind=='code':out.append('<pre><code>'+html.escape(b['text'])+'</code></pre>')
            elif kind=='table':out.append('<div class="table-wrap"><table><thead><tr>'+''.join('<th scope="col">'+html.escape(x)+'</th>' for x in b['headers'])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+x+'</td>' for x in row)+'</tr>' for row in b['rows'])+'</tbody></table></div>')
        out.append('<p class="chapter-return"><a href="#guide-nav">Back to all chapters</a></p></section>')
        sections.append('\n'.join(out))
    template=(ROOT/'guide-site/template.html').read_text()
    for key,value in {'GUIDE_CONTENT':'\n'.join(sections),'GUIDE_NAV':'<ol>'+'\n'.join(nav)+'</ol>','GUIDE_VERSION':guide['version'],'GUIDE_DATE':guide['date']}.items():template=template.replace('{{'+key+'}}',value)
    if '{{GUIDE_' in template:raise ValueError('Unresolved template token')
    (ROOT/'guide-site/index.html').write_text(template)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--html-only',action='store_true');args=parser.parse_args()
    guide=load_guide();html_build(guide)
    if not args.html_only:
        destination=ROOT/'output/pdf/Taskivra-AI-Guide.pdf';destination.parent.mkdir(parents=True,exist_ok=True)
        pdf_build(guide,destination);shutil.copyfile(destination,ROOT/'guide-site/Taskivra-AI-Guide.pdf')
    print(json.dumps({'chapters':len(guide['sections']),'html':'guide-site/index.html','pdf':'output/pdf/Taskivra-AI-Guide.pdf'}))

if __name__=='__main__':main()
