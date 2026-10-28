

(()=>{'use strict';
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const imageManifest=window.ITD_ASSETS;const imagery=Object.fromEntries(Object.entries(imageManifest).map(([id,a])=>[id,a.sizes['900']||Object.values(a.sizes).at(-1)]));
function setResponsive(img,id,sizes='100vw',thumb=false){const a=imageManifest[id];if(!a)return;img.src=thumb?(a.sizes['360']||a.sizes['900']):imagery[id];img.srcset=Object.entries(a.sizes).filter(([w])=>!thumb||Number(w)<=900).map(([w,p])=>p+' '+w+'w').join(', ');img.sizes=sizes;img.width=a.width;img.height=a.height;img.decoding='async';}
$$('[data-asset]').filter(img=>img.id!=='project-dialog-image').forEach(img=>setResponsive(img,img.dataset.asset,img.sizes||'100vw'));

const menu=$('#nav-mobile-toggle'),mobile=$('#mobile-links');
function closeMenu(){mobile.hidden=true;menu.setAttribute('aria-expanded','false');menu.textContent='МЕНЮ +'}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')==='true';mobile.hidden=open;menu.setAttribute('aria-expanded',String(!open));menu.textContent=open?'МЕНЮ +':'ЗАКРЫТЬ −'});
mobile.addEventListener('click',e=>{if(e.target.closest('a'))closeMenu()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!mobile.hidden){closeMenu();menu.focus()}});
matchMedia('(min-width:951px)').addEventListener('change',e=>{if(e.matches)closeMenu()});
const detailData=[{"title": "Свет для разных моментов", "copy": "Вечерний ракурс спальни показывает, как меняется настроение комнаты: бра у изголовья создают мягкий локальный свет, а люстра остаётся отдельным акцентом.", "main": "baltica-20261026-46", "asset": "baltica-20261026-44", "room": "bedroom", "mainAlt": "ЖК Балтийский — вечернее освещение спальни", "alt": "Прикроватная композиция: бра, тумба и мягкое изголовье", "caption": "СПАЛЬНЯ / ПРИКРОВАТНАЯ КОМПОЗИЦИЯ", "label": "ЖК БАЛТИЙСКИЙ / СПАЛЬНЯ"}, {"title": "Хранение как часть архитектуры", "copy": "В прихожей шкафы становятся частью композиции. Зеркальные вставки, тёмные фасады и тонкие металлические линии задают ритм; крупный ракурс раскрывает оформление ручек.", "main": "baltica-20261026-30", "asset": "baltica-20261026-29", "room": "entry", "mainAlt": "ЖК Балтийский — шкафы и зеркала прихожей", "alt": "Деталь фасада шкафа: ручки с декоративными кистями", "caption": "ПРИХОЖАЯ / ДЕТАЛЬ ФАСАДА", "label": "ЖК БАЛТИЙСКИЙ / ПРИХОЖАЯ"}, {"title": "Фактуры, которые связывают комнату", "copy": "В спальне рисунок стены поддерживает тёплую палитру, а мягкое изголовье и многослойный текстиль делают её спокойнее. Детальный ракурс показывает сочетание узора и однотонных тканей.", "main": "baltica-20261026-40", "asset": "baltica-20261026-42", "room": "bedroom", "mainAlt": "ЖК Балтийский — общая палитра спальни", "alt": "Текстиль спальни: покрывало, подушки и мягкое изголовье", "caption": "СПАЛЬНЯ / ТЕКСТИЛЬ И ФАКТУРЫ", "label": "ЖК БАЛТИЙСКИЙ / СПАЛЬНЯ"}];let activeDetail=0;
function setDetail(n){activeDetail=n;const d=detailData[n];$$('[data-detail]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.detail)===n)));$('#detail-count').textContent=String(n+1).padStart(2,'0')+' / 03';$('#detail-title').textContent=d.title;$('#detail-copy').textContent=d.copy;setResponsive($('#detail-image'),d.asset,'(max-width:700px) 100vw, 35vw');$('#detail-image').alt=d.alt;$('#detail-caption').textContent=d.caption;setResponsive($('#atlas-main-image'),d.main,'(max-width:700px) 100vw, 65vw');$('#atlas-main-image').alt=d.mainAlt;$('#atlas-main-caption').textContent=d.label;$('.atlas-open').setAttribute('aria-label','Открыть: '+d.mainAlt);$('.detail-open').setAttribute('aria-label','Открыть: '+d.alt);$('.atlas-room-link').dataset.exploreRoom=d.room;const p=$('#atlas-panel');p.classList.remove('detail-change');void p.offsetWidth;p.classList.add('detail-change')}
$$('[data-detail]').forEach(b=>b.addEventListener('click',()=>setDetail(Number(b.dataset.detail))));
const projects=window.ITD_PROJECTS.map(p=>({...p,photos:p.gallery.map(g=>[g.assetId,g.caption])}));let projectIndex=0,imageIndex=0,lastFocus=null,galleryItems=[],galleryRoomLabel="Все помещения";
function openDialog(d){lastFocus=document.activeElement;d.showModal();document.body.style.overflow='hidden';d.scrollTop=0;d.querySelector('.close-dialog').focus()}
$$('dialog:not(.inside-plan-dialog):not(.contact-modal)').forEach(d=>{d.querySelector('.close-dialog').addEventListener('click',()=>d.close());d.addEventListener('close',()=>{document.body.style.overflow='';if(lastFocus)lastFocus.focus({preventScroll:true})})});
function showImage(n){const p=projects[projectIndex];imageIndex=(n+galleryItems.length)%galleryItems.length;const [key,caption]=galleryItems[imageIndex];const image=$('#project-dialog-image');image.removeAttribute('srcset');image.src=imageManifest[key].full;image.alt=p.name+' — '+caption+' (визуализация)';image.classList.remove('gallery-image-enter');void image.offsetWidth;image.classList.add('gallery-image-enter');const count=String(imageIndex+1).padStart(2,'0')+' / '+String(galleryItems.length).padStart(2,'0');$('#gallery-room-label').textContent=galleryRoomLabel+' / '+caption.split('.')[0];$('#gallery-position').textContent=count+' · '+caption;$('#gallery-overlay-count').textContent=count;const strip=$('#gallery-thumbnails');strip.querySelectorAll('button').forEach((b,i)=>{b.setAttribute('aria-pressed',String(i===imageIndex));if(i===imageIndex){const left=b.offsetLeft-strip.offsetLeft;if(left<strip.scrollLeft)strip.scrollLeft=left;else if(left+b.offsetWidth>strip.scrollLeft+strip.clientWidth)strip.scrollLeft=left+b.offsetWidth-strip.clientWidth}});document.dispatchEvent(new CustomEvent('itd:gallery-image',{detail:{projectId:p.id,assetId:key}}));}
function showProject(n,keys=null,first=null,label='Все помещения'){projectIndex=(n+projects.length)%projects.length;const p=projects[projectIndex];galleryItems=keys?keys.map(key=>p.photos.find(photo=>photo[0]===key)).filter(Boolean):p.photos;galleryRoomLabel=label;$('#project-inside-link').hidden=!p.plan;$('#project-dialog-title').textContent=p.name;$('#project-dialog-meta').textContent=p.meta;$('#project-position').textContent='ПРОЕКТ / '+String(projectIndex+1).padStart(2,'0')+' ИЗ '+String(projects.length).padStart(2,'0');const strip=$('#gallery-thumbnails');strip.replaceChildren(...galleryItems.map(([key,caption],i)=>{const button=document.createElement('button');button.type='button';button.className='gallery-thumb';button.setAttribute('aria-label','Кадр '+(i+1)+': '+caption);const img=document.createElement('img');setResponsive(img,key,'80px',true);img.alt='';img.loading='lazy';img.draggable=false;button.append(img);button.addEventListener('click',()=>showImage(i));return button}));strip.scrollLeft=0;showImage(Math.max(0,galleryItems.findIndex(photo=>photo[0]===first)));$('#project-dialog').scrollTop=0}
$$('[data-project]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();routeProject(projects[Number(b.dataset.project)].id)}));
$('#previous-project').addEventListener('click',()=>showProject(projectIndex-1));$('#next-project').addEventListener('click',()=>showProject(projectIndex+1));
$('#previous-image').addEventListener('click',()=>showImage(imageIndex-1));$('#next-image').addEventListener('click',()=>showImage(imageIndex+1));
$('#project-dialog').addEventListener('keydown',e=>{if(e.key==='ArrowRight'){e.preventDefault();showImage(imageIndex+1)}if(e.key==='ArrowLeft'){e.preventDefault();showImage(imageIndex-1)}});
let swipeStart=null;const media=$('#gallery-media');media.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'&&!e.target.closest('button'))swipeStart={x:e.clientX,y:e.clientY}});media.addEventListener('pointerup',e=>{if(!swipeStart)return;const dx=e.clientX-swipeStart.x,dy=e.clientY-swipeStart.y;swipeStart=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.5)showImage(imageIndex+(dx<0?1:-1))});media.addEventListener('pointercancel',()=>swipeStart=null);$('#project-dialog-image').draggable=false;
const rates={max:5000,mid:4200,sos:2800,plan:1500},included={
        max: [
          'Обмерочный чертёж и планировка',
          '2D-коллаж и 3D-визуализация',
          'Рабочая документация',
          'Ведомости мебели и материалов',
          'Сопровождение и закупка со скидками дизайнера'
        ],
        mid: [
          'Обмерочный чертёж и планировка',
          '2D-коллаж',
          'Рабочая документация',
          'Ведомости мебели и материалов',
          'Сопровождение и закупка со скидками дизайнера'
        ],
        sos: [
          'Обмерочный чертёж и планировка',
          'Полы и тёплые полы, потолок',
          'Освещение, розетки, выключатели',
          'План групп включения'
        ],
        plan: [
          'Обмерочный чертёж',
          'План демонтажа и план после перепланировки',
          'Расстановка мебели с размерами',
          'План сантехники'
        ]
      };
const rub=n=>Math.round(n).toLocaleString('ru-RU')+' ₽';
function calculate(){const raw=$('#area').value,a=Number(raw),valid=raw!==''&&Number.isFinite(a)&&a>0&&a<=100000,p=$('#package').value,sup=$('#supervision').checked,months=Number($('#months').value);$('#months-field').hidden=!sup;const ul=$('#included-list');ul.replaceChildren(...included[p].map(s=>{const li=document.createElement('li');li.textContent=s;return li}));$$('.choose-pack').forEach(b=>{b.closest('.price-row').classList.toggle('selected',b.dataset.pack===p);b.setAttribute('aria-pressed',String(b.dataset.pack===p))});if(!valid){$('#area').setAttribute('aria-invalid','true');$('#calc-total').textContent='—';$('#calc-breakdown').textContent='Укажите площадь больше 0 м².';$('#calc-rule').textContent='';return}$('#area').removeAttribute('aria-invalid');const discount=a>=200?400:a>=100?200:0;const design=a<=30?rates[p]*30:a*(rates[p]-discount),extra=sup?35000*months:0;$('#calc-total').textContent=(sup?'от ':'')+rub(design+extra);$('#calc-breakdown').textContent='Проект '+p.toUpperCase()+': '+rub(design)+(sup?' · надзор: от '+rub(extra):'');$('#calc-rule').textContent=a<=30?'Для объектов до 30 м² включительно действует фиксированная стоимость за 30 м².':discount?'Тариф для этой площади: '+rub(rates[p]-discount)+'/м². Снижение на '+rub(discount)+'/м² учтено.':'Тариф: '+rub(rates[p])+'/м².'}
['area','package','supervision','months'].forEach(id=>$('#'+id).addEventListener('input',calculate));
function choosePackage(p){$('#package').value=p;calculate();$('#calculator').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});$('#area').focus({preventScroll:true})}
$$('[data-pack]').forEach(b=>b.addEventListener('click',()=>choosePackage(b.dataset.pack)));calculate();
const checks=$$('.check-item'),storageKey='itd-checklist';try{const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');checks.forEach((b,i)=>b.checked=saved.includes(i))}catch(e){}
function checkProgress(save=false){const n=checks.filter(b=>b.checked).length;$('#check-count').textContent='Отмечено '+n+' из 24';$('#check-progress').value=n;if(save){try{localStorage.setItem(storageKey,JSON.stringify(checks.map((b,i)=>b.checked?i:null).filter(i=>i!==null)))}catch(e){$('#check-status').textContent='Отметки доступны до закрытия страницы.'}}}
checks.forEach(b=>b.addEventListener('change',()=>checkProgress(true)));checkProgress();
$$('[data-open-checklist]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();openDialog($('#checklist-dialog'))}));
$('#reset-checklist').addEventListener('click',()=>{checks.forEach(b=>b.checked=false);checkProgress(true);$('#check-status').textContent='Отметки сброшены.'});
$('#copy-checklist').addEventListener('click',async()=>{const text='ITD Studio — Чек-лист забытых мелочей\n'+checks.map((b,i)=>(b.checked?'✓ ':'□ ')+(i+1)+'. '+b.nextElementSibling.textContent).join('\n');try{await navigator.clipboard.writeText(text);$('#check-status').textContent='Список скопирован.'}catch(e){$('#check-status').textContent='Копирование недоступно в этом браузере.'}});
const questions=[
        {
          q: 'С чего вы начнёте ремонт?',
          a: [
            ['С подробного плана: где что стоит и куда подключается', 'A'],
            ['С идеи в голове и нескольких референсов', 'B'],
            ['С бригады и сметы', 'C'],
            ['Куплю то, что понравится, и разберусь по ходу', 'D']
          ]
        },
        {
          q: 'Как вы выбираете мебель?',
          a: [
            ['Сверяю размеры, материалы и цвета в таблице', 'A'],
            ['Беру то, что вписывается в замысел', 'B'],
            ['Главное, чтобы удобно и недорого', 'C'],
            ['Нахожу интересное, потом ищу, куда поставить', 'D']
          ]
        },
        {
          q: 'Что больше всего раздражает в чужих квартирах?',
          a: [
            ['Розетки не там, где нужны', 'A'],
            ['Нет стиля, всё случайно', 'B'],
            ['Красиво, но неудобно', 'C'],
            ['Всё слишком идеально, как в каталоге', 'D']
          ]
        },
        {
          q: 'Насколько вы готовы участвовать в процессе?',
          a: [
            ['Хочу контролировать каждый этап', 'A'],
            ['Хочу принимать ключевые решения', 'B'],
            ['Хочу получить чертежи и передать подрядчикам', 'C'],
            ['Хочу часть сделать сам', 'D']
          ]
        },
        {
          q: 'Какой результат для вас идеальный?',
          a: [
            ['Ни одной забытой мелочи', 'A'],
            ['Интерьер выглядит ровно так, как задумано', 'B'],
            ['Квартира, где всё работает', 'C'],
            ['Пространство с характером', 'D']
          ]
        }
      ],results={
        A: {
          title: 'Перфекционист', pack: 'MAX', value: 'max',
          text: 'Вы замечаете мелочи раньше всех, и вам важно, чтобы всё было продумано до последней розетки и ручки. Вам подойдёт полный проект с 3D-визуализацией и сопровождением.'
        },
        B: {
          title: 'Режиссёр', pack: 'MID', value: 'mid',
          text: 'У вас есть замысел, и вы хотите, чтобы он воплотился точно. Вам нужны чертежи, ведомости и сопровождение, а картинку результата вы представляете сами.'
        },
        C: {
          title: 'Практик', pack: 'SOS', value: 'sos',
          text: 'Для вас главное, чтобы всё работало и ремонт шёл по плану. Вам подойдёт набор чертежей для бригады: полы, потолки, свет и розетки.'
        },
        D: {
          title: 'Творец', pack: 'PLAN', value: 'plan',
          text: 'Вы любите собирать интерьер сами и делать его живым. Вам нужна крепкая основа: продуманная планировка и расстановка мебели.'
        }
      };let qi=0,answers=[];
function drawQuiz(){const c=$('#quiz-content');c.replaceChildren();$('#quiz-back').hidden=qi===0;$('#quiz-next').disabled=!answers[qi];$('#quiz-next').textContent=qi===questions.length-1?'Показать результат →':'Далее →';if(qi===questions.length){$('#quiz-back').hidden=false;$('#quiz-back').textContent='Пройти заново';$('#quiz-next').hidden=true;const counts={A:0,B:0,C:0,D:0};answers.forEach(a=>counts[a]++);const type=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0],r=results[type];const h=document.createElement('h3');h.className='quiz-question';h.textContent=r.title;const p=document.createElement('p');p.className='quiz-result-text';p.textContent=r.text;const note=document.createElement('p');note.className='quiz-recommendation';note.textContent='Ваш ориентир — '+r.pack+'. Тест помогает начать разговор о составе проекта.';const b=document.createElement('button');b.type='button';b.className='text-link quiz-calc';b.textContent='Рассчитать '+r.pack+' ↗';b.addEventListener('click',()=>{$('#quiz-dialog').close();choosePackage(r.value)});c.append(h,p,note,b);return}$('#quiz-next').hidden=false;$('#quiz-back').textContent='← Назад';const progress=document.createElement('p');progress.className='quiz-progress';progress.textContent=String(qi+1).padStart(2,'0')+' / 05';const question=document.createElement('h3');question.className='quiz-question';question.textContent=questions[qi].q;c.append(progress,question);questions[qi].a.forEach(([text,type])=>{const label=document.createElement('label');label.className='quiz-option';const input=document.createElement('input');input.type='radio';input.name='quiz-answer';input.value=type;input.checked=answers[qi]===type;input.addEventListener('change',()=>{answers[qi]=type;$('#quiz-next').disabled=false});const span=document.createElement('span');span.textContent=text;label.append(input,span);c.append(label)})}
$$('[data-open-quiz]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();drawQuiz();openDialog($('#quiz-dialog'))}));$('#quiz-next').addEventListener('click',()=>{if(!answers[qi])return;qi++;drawQuiz();$('#quiz-dialog').scrollTop=0});$('#quiz-back').addEventListener('click',()=>{if(qi===questions.length){qi=0;answers=[]}else qi=Math.max(0,qi-1);drawQuiz()});
if(!matchMedia('(prefers-reduced-motion:reduce)').matches&&'IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');observer.unobserve(e.target)}})},{threshold:.08});$$('.section-head,.project-feature,.project-pair article,.method-grid,.notes,.philosophy p').forEach(e=>{e.classList.add('reveal-ready');observer.observe(e)})}
const INSIDE_PLAN_SOURCE='https://configure-assets-host.invalid/itd/assets/baltiyskiy-plan.webp';
/* Stable content IDs. Sources: supplied volume plan + existing project imagery.
   All room descriptions below describe visible layout only. No dimensions or manufacturers are inferred.
   Connect a real technical plan by adding views.technical={label,src,width,height,geometry,markers}.
   geometry/markers use the same room and decision IDs; no visible 2D control until configured. */
function explorerConfig(p){return {projectId:p.id,name:p.name,idPrefix:'inside-'+p.id,viewId:p.defaultView,views:p.plan,photos:p.photoRegistry,rooms:p.rooms,decisions:p.decisions,details:p.details,atlas:p.atlas||{}}}
let insideConfig=explorerConfig(window.ITD_PROJECTS.find(p=>p.plan));

/* Framework-independent component: one instance owns its map, selection and zoom.
   Project imagery stays in the existing imagery registry; only stable IDs are referenced here. */
class SpaceExplorer {
 constructor(root,config,adapters){this.root=root;this.config=config;this.adapters=adapters;this.mode='rooms';this.selectedId=null;this.photoId=null;this.state='overview';this.viewId=config.viewId;this.zoom=1;this.$=s=>root.querySelector(s);this.$$=s=>[...root.querySelectorAll(s)];this.prefix=config.idPrefix||root.id||config.projectId;this.panelId=this.prefix+'-panel';this.$('.inside-panel').id=this.panelId;this.$$('[data-mode]').forEach(b=>{b.id=this.prefix+'-'+b.dataset.mode+'-tab';b.setAttribute('aria-controls',this.panelId)});this.$('.inside-panel').setAttribute('aria-labelledby',this.prefix+'-rooms-tab');this.stage=this.$('.inside-stage');this.zoomDialog=this.$('.inside-plan-dialog');this.buildViews();this.buildMap();this.bind();this.render();}
 get view(){return this.config.views[this.viewId]}
 get items(){return this.mode==='rooms'?this.config.rooms:this.config.decisions}
 get selected(){return this.items.find(i=>i.id===this.selectedId)}
 get photoIds(){return this.selected?.photos||this.config.rooms.find(r=>r.id==='living').photos}
 getPhoto(id){return this.config.photos[id]}
 text(selector,value){this.$(selector).textContent=value}
 setState(value){this.state=value;this.root.dataset.state=value}
 animate(el,name){el.classList.remove(name);void el.offsetWidth;el.classList.add(name)}
 buildViews(){const ids=Object.keys(this.config.views).filter(id=>this.config.views[id]?.src);const tabs=this.$('.inside-view-tabs');tabs.hidden=ids.length<2;ids.forEach(id=>{const b=document.createElement('button');b.type='button';b.textContent=this.config.views[id].label;b.setAttribute('aria-pressed',String(id===this.viewId));b.addEventListener('click',()=>{this.viewId=id;tabs.querySelectorAll('button').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));this.buildMap();this.render()});tabs.append(b)})}
 buildMap(){const v=this.view;this.stage.style.aspectRatio=v.width+'/'+v.height;this.$('.inside-plan-image').loading='lazy';this.$('.inside-plan-image').src=v.src;this.$('.inside-plan-image').width=v.width;this.$('.inside-plan-image').height=v.height;this.$('.inside-overlay').setAttribute('viewBox',`0 0 ${v.width} ${v.height}`);const regions=this.$('.inside-regions');regions.replaceChildren();const markers=this.$('.inside-markers');markers.replaceChildren();const index=this.$('.inside-index');index.replaceChildren();index.setAttribute('aria-label',this.mode==='rooms'?'Помещения квартиры':'Дизайнерские решения');
 this.items.forEach((item,i)=>{const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.dataset.zone=item.id;const shapes=this.mode==='rooms'?[[item.id,'']]:item.regions;shapes.forEach(([geometryId,color])=>{const d=v.geometry[geometryId];if(!d)return;const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);path.setAttribute('class','inside-region '+color);path.dataset.zone=item.id;path.addEventListener('pointerenter',()=>this.hover(item.id));path.addEventListener('pointerleave',()=>this.hover(null));path.addEventListener('click',()=>this.select(item.id));group.append(path)});regions.append(group);
 const pos=v.markers[item.id];if(pos){const b=document.createElement('button');b.type='button';b.className='inside-marker';b.dataset.zone=item.id;b.style.left=pos[0]/v.width*100+'%';b.style.top=pos[1]/v.height*100+'%';b.setAttribute('aria-label',String(i+1).padStart(2,'0')+' / '+item.name);b.setAttribute('aria-controls',this.panelId);b.setAttribute('aria-pressed','false');const dot=document.createElement('span');dot.textContent=String(i+1).padStart(2,'0');b.append(dot);b.addEventListener('click',()=>this.select(item.id));b.addEventListener('pointerenter',()=>this.hover(item.id));b.addEventListener('pointerleave',()=>this.hover(null));b.addEventListener('focus',()=>this.hover(item.id));b.addEventListener('blur',()=>this.hover(null));markers.append(b)}
 const choice=document.createElement('button');choice.type='button';choice.dataset.zone=item.id;choice.setAttribute('aria-pressed','false');choice.setAttribute('aria-controls',this.panelId);const number=document.createElement('span');number.textContent=String(i+1).padStart(2,'0');choice.append(number,document.createTextNode(item.short||item.name));choice.addEventListener('click',()=>this.select(item.id));index.append(choice);
 });this.highlight();}
 hover(id){this.$$('.inside-region').forEach(el=>el.classList.toggle('is-hover',el.dataset.zone===id));this.$$('.inside-marker').forEach(el=>el.classList.toggle('is-hover',el.dataset.zone===id));const tip=this.$('.inside-map-tooltip');tip.classList.toggle('is-visible',!!id);if(id){const p=this.view.markers[id];tip.textContent=this.items.find(i=>i.id===id).name;tip.style.left=Math.max(18,Math.min(82,p[0]/this.view.width*100))+'%';tip.style.top=`calc(${p[1]/this.view.height*100}% - 24px)`;}}
 highlight(){this.$$('.inside-region').forEach(el=>{const active=el.dataset.zone===this.selectedId;el.classList.toggle('is-active',active);if(this.mode==='decisions')el.style.pointerEvents=active?'fill':'none';else el.style.pointerEvents='fill'});this.$$('[data-zone]:is(button)').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.zone===this.selectedId)));this.$('.inside-legend').hidden=!(this.mode==='decisions'&&this.selectedId==='zoning')}
 setMode(mode){this.mode=mode;this.selectedId=null;this.photoId=null;this.setState('overview');this.$$('[data-mode]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.mode===mode));b.tabIndex=b.dataset.mode===mode?0:-1});this.$('.inside-panel').setAttribute('aria-labelledby',this.prefix+'-'+mode+'-tab');this.buildMap();this.render();this.text('.inside-map-hint',mode==='rooms'?'Выберите номер или свободную область помещения.':'Выберите идею, чтобы увидеть её на плане.');}
 select(id,{scroll=true}={}){const item=this.items.find(i=>i.id===id);if(!item)return;this.selectedId=id;this.photoId=item.photos[0]||null;this.setState(this.mode==='rooms'?'room-selected':'decision-selected');this.render();this.text('.inside-zoom-selection',item.name+' — подробности под планом');if(scroll&&!this.zoomDialog.open&&matchMedia('(max-width:700px)').matches){this.$('.inside-panel').scrollIntoView({behavior:this.motion(),block:'start'})}}
 motion(){return matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'}
 reset(){this.selectedId=null;this.photoId=null;this.setState('overview');this.render();this.hover(null);this.text('.inside-zoom-selection','Общий план');this.$('.inside-map-home').scrollIntoView({behavior:this.motion(),block:'start'})}
 navigate(direction){const i=this.items.findIndex(item=>item.id===this.selectedId);this.select(this.items[(i+direction+this.items.length)%this.items.length].id,{scroll:false})}
 render(){const item=this.selected;this.highlight();const i=this.items.indexOf(item);this.text('.inside-panel-index',item?`${this.mode==='rooms'?'ПОМЕЩЕНИЕ':'РЕШЕНИЕ'} / ${String(i+1).padStart(2,'0')} ИЗ ${String(this.items.length).padStart(2,'0')}`:'ЖК БАЛТИЙСКИЙ / '+(this.mode==='rooms'?'ОБЗОР':'ДИЗАЙНЕРСКИЕ РЕШЕНИЯ'));this.text('.inside-panel-title',item?item.name:this.mode==='rooms'?'От общего — к частному.':'Почему пространство работает.');this.text('.inside-panel-copy',item?item.copy:this.mode==='rooms'?'Семь зон, одна квартира. Выберите помещение на плане: от общей гостиной до тихого рабочего места у окна.':'План раскрывает логику пространства. Выберите категорию, чтобы увидеть зонирование, хранение и связи между повседневными сценариями.');
 const list=this.$('.inside-features');list.replaceChildren();(item?.features||[]).forEach(t=>{const li=document.createElement('li');li.textContent=t;list.append(li)});const related=this.$('.inside-related');related.replaceChildren();if(this.mode==='rooms'&&item)(item.decisions||[]).forEach(id=>{const d=this.config.decisions.find(x=>x.id===id);const b=document.createElement('button');b.type='button';b.textContent=d.name+' ↗';b.addEventListener('click',()=>{this.setMode('decisions');this.select(id,{scroll:false})});related.append(b)});
 const atlas=this.$('.inside-atlas-link');atlas.hidden=!item?.atlasId;atlas.dataset.detailId=item?.atlasId||'';this.$('.inside-bottom-nav').hidden=!item;this.text('.inside-prev','← Предыдущее '+(this.mode==='rooms'?'помещение':'решение'));this.text('.inside-next','Следующее '+(this.mode==='rooms'?'помещение':'решение')+' →');this.$('.inside-photo-absence').hidden=!item||item.photos.length>0;if(item&&!item.photos.length)this.text('.inside-photo-absence',this.mode==='rooms'?'Визуализации этого помещения пока не опубликованы. Здесь можно изучить его расположение на плане.':'Системы хранения показаны на плане. Отдельные визуализации этих шкафов пока не опубликованы.');
 if(!item&&this.mode==='decisions'){this.$('.inside-photo-block').hidden=true;}else{this.$('.inside-photo-block').hidden=this.photoIds.length===0;if(this.photoIds.length){if(!this.photoIds.includes(this.photoId))this.photoId=this.photoIds[0];this.renderPhoto();}}
 this.animate(this.$('.inside-panel'),'inside-panel-change');this.text('.inside-announcement',item?item.name+(item.photos.length?'. Доступно ракурсов: '+item.photos.length:'. Без визуализаций.'):'Общий план. Выберите '+(this.mode==='rooms'?'помещение.':'решение.'));}
 renderPhoto(){const photo=this.getPhoto(this.photoId);if(!photo)return;const image=this.$('.inside-photo');image.src=this.adapters.image(photo.assetId);image.alt=this.config.name+' — '+photo.caption+' (визуализация)';this.animate(image,'inside-photo-change');const index=this.photoIds.indexOf(this.photoId);this.text('.inside-photo-caption',photo.caption);this.text('.inside-photo-count',`${String(index+1).padStart(2,'0')} / ${String(this.photoIds.length).padStart(2,'0')}`);this.$('.inside-photo-prev').hidden=this.$('.inside-photo-next').hidden=this.photoIds.length<2;const thumbs=this.$('.inside-photo-thumbs');thumbs.replaceChildren();thumbs.hidden=this.photoIds.length<2;this.photoIds.forEach(id=>{const p=this.getPhoto(id);const b=document.createElement('button');b.type='button';b.setAttribute('aria-label',p.caption);b.setAttribute('aria-pressed',String(id===this.photoId));const img=document.createElement('img');img.src=this.adapters.image(p.assetId);img.alt='';img.loading='lazy';b.append(img);b.addEventListener('click',()=>{this.photoId=id;this.renderPhoto()});thumbs.append(b)})}
 changePhoto(delta){if(!this.photoIds.length)return;const i=this.photoIds.indexOf(this.photoId);this.photoId=this.photoIds[(i+delta+this.photoIds.length)%this.photoIds.length];this.renderPhoto()}
 receiveGallery(assetId){const entry=Object.entries(this.config.photos).find(([,photo])=>photo.assetId===assetId);if(!entry)return;const [id,photo]=entry;if(this.mode==='decisions'&&this.selectedId){if(this.photoIds.includes(id)){this.photoId=id;this.renderPhoto()}return;}this.mode='rooms';this.selectedId=photo.roomIds[0];this.photoId=id;this.render();}
 openZoom(){this.zoomReturn=document.activeElement;this.zoom=1;this.$('.inside-zoom-canvas').append(this.stage);this.zoomDialog.showModal();document.body.style.overflow='hidden';this.applyZoom();this.$('.inside-zoom-close').focus()}
 closeZoom(){this.zoomDialog.close()}
 applyZoom(){const c=this.$('.inside-zoom-canvas');c.style.width=this.zoom===1?'min(100%,1000px)':Math.round(this.$('.inside-zoom-scroll').clientWidth*this.zoom)+'px';this.text('.inside-zoom-value',Math.round(this.zoom*100)+'%');this.$('.inside-zoom-out').disabled=this.zoom<=1;this.$('.inside-zoom-in').disabled=this.zoom>=3}
 bind(){this.$$('[data-mode]').forEach(b=>b.addEventListener('click',()=>this.setMode(b.dataset.mode)));this.$('.inside-mode-tabs').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const mode=e.key==='Home'?'rooms':e.key==='End'?'decisions':this.mode==='rooms'?'decisions':'rooms';this.setMode(mode);this.$(`[data-mode="${mode}"]`).focus()}});this.$('.inside-reset').addEventListener('click',()=>this.reset());this.$('.inside-prev').addEventListener('click',()=>this.navigate(-1));this.$('.inside-next').addEventListener('click',()=>this.navigate(1));this.$('.inside-photo-prev').addEventListener('click',()=>this.changePhoto(-1));this.$('.inside-photo-next').addEventListener('click',()=>this.changePhoto(1));this.$('.inside-photo-open').addEventListener('click',()=>{this.beforeExpanded=this.selectedId?(this.mode==='rooms'?'room-selected':'decision-selected'):'overview';this.setState('image-expanded');this.adapters.openPhoto(this.getPhoto(this.photoId).assetId)});this.$('.inside-atlas-link').addEventListener('click',e=>{e.preventDefault();this.adapters.openDetail(this.$('.inside-atlas-link').dataset.detailId)});
 this.$('.inside-zoom').addEventListener('click',()=>this.openZoom());this.$('.inside-zoom-close').addEventListener('click',()=>this.closeZoom());this.zoomDialog.addEventListener('close',()=>{this.$('.inside-map-home').append(this.stage);document.body.style.overflow='';this.hover(null);this.zoomReturn?.focus({preventScroll:true});if(this.selectedId&&matchMedia('(max-width:700px)').matches)this.$('.inside-panel').scrollIntoView({behavior:this.motion(),block:'start'})});this.$('.inside-zoom-in').addEventListener('click',()=>{this.zoom=Math.min(3,this.zoom+.5);this.applyZoom()});this.$('.inside-zoom-out').addEventListener('click',()=>{this.zoom=Math.max(1,this.zoom-.5);this.applyZoom()});
 let touch=null;const surface=this.$('.inside-photo-open');surface.style.touchAction='pan-y';surface.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')touch=[e.clientX,e.clientY]});surface.addEventListener('pointerup',e=>{if(!touch)return;const dx=e.clientX-touch[0],dy=e.clientY-touch[1];touch=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.5){this.changePhoto(dx<0?1:-1);this.suppressPhotoClick=true;setTimeout(()=>this.suppressPhotoClick=false,350)}});surface.addEventListener('pointercancel',()=>touch=null);surface.addEventListener('click',e=>{if(this.suppressPhotoClick){e.preventDefault();e.stopImmediatePropagation()}},true);
 this.root.addEventListener('keydown',e=>{if(e.key==='Escape'&&!this.zoomDialog.open&&this.selectedId){e.preventDefault();this.reset();this.$(`[data-mode="${this.mode}"]`).focus({preventScroll:true})}});
 }
}
// Extend the supplied SpaceExplorer: preserve map geometry and state machine.
class InsideExplorer2 extends SpaceExplorer {
 get allPhotoIds(){return this.selected?.photos||this.config.rooms[0].photos}
 get photoIds(){const item=this.selected||this.config.rooms[0];return item.featured||item.photos.slice(0,4)}
 buildMap(){
  super.buildMap();const c=this.view.crop;if(!c)return;
  this.stage.style.aspectRatio=c.width+'/'+c.height;this.$('.inside-overlay').setAttribute('viewBox',`${c.x} ${c.y} ${c.width} ${c.height}`);
  const im=this.$('.inside-plan-image');im.loading='lazy';im.style.width=this.view.width/c.width*100+'%';im.style.height=this.view.height/c.height*100+'%';im.style.left=-c.x/c.width*100+'%';im.style.top=-c.y/c.height*100+'%';
  this.$$('.inside-marker').forEach(b=>{const p=this.view.markers[b.dataset.zone];b.style.left=(p[0]-c.x)/c.width*100+'%';b.style.top=(p[1]-c.y)/c.height*100+'%'});
 }
 hover(id){super.hover(id);if(id&&this.view.crop){const c=this.view.crop,p=this.view.markers[id],tip=this.$('.inside-map-tooltip');tip.style.left=Math.max(18,Math.min(82,(p[0]-c.x)/c.width*100))+'%';tip.style.top=`calc(${(p[1]-c.y)/c.height*100}% - 24px)`}}
 setMode(mode){this.showPoints=false;this.activeDetail=null;super.setMode(mode);if(mode==='decisions'&&this.config.decisions.length)this.select(this.config.decisions[0].id,{scroll:false})}
 select(id,{scroll=true}={}){this.showPoints=false;this.activeDetail=null;super.select(id,{scroll:false});const item=this.items.find(x=>x.id===id);if(item?.featured?.length){this.photoId=item.featured[0];this.renderPhoto()}this.$('.inside-selection-label').textContent=item?item.name:'Обзор квартиры';if(scroll&&matchMedia('(max-width:700px)').matches&&!this.zoomDialog.open)this.$('.inside-panel').scrollIntoView({behavior:this.motion(),block:'start'});}
 reset(){this.showPoints=false;this.activeDetail=null;super.reset();this.$('.inside-selection-label').textContent='Вся квартира / '+this.config.rooms.length+' помещений'}
 render(){
  super.render();const item=this.selected;if(!item){this.text('.inside-panel-index',this.config.name.toUpperCase()+' / ОБЗОР');this.text('.inside-panel-copy',this.config.projectId==='baltiyskiy'?'Семь зон, одна квартира. Выберите помещение на плане: от общей гостиной до тихого рабочего места у окна.':'Выберите помещение на плане, чтобы увидеть интерьер и связанные решения.');}
  this.$('.inside-selection-label').textContent=item?item.name:'Вся квартира / '+this.config.rooms.length+' помещений';
  const explanation=this.$('.inside-decision-explanation');explanation.replaceChildren();
  const choices=this.$('.inside-detail-choices');choices.replaceChildren();
  if(this.mode==='decisions'&&item){
   const dl=decisionDL(item.explanation);explanation.append(dl);
   for(const id of item.detailIds||[]){const d=this.config.details.find(x=>x.id===id);if(!d)continue;const b=document.createElement('button');b.type='button';b.textContent=d.title+' ↗';b.addEventListener('click',()=>this.openSpecificDetail(d));choices.append(b)}
  }
  this.$('.inside-atlas-link').hidden=true;
 }
 renderPhoto(){
  const photo=this.getPhoto(this.photoId);if(!photo)return;
  const im=this.$('.inside-photo'),a=imageManifest[photo.assetId];setResponsive(im,photo.assetId,'(max-width:700px) 100vw, 50vw');im.alt=this.config.name+' — '+photo.caption;
  const surface=this.$('.inside-photo-frame');surface.style.aspectRatio=a.width+'/'+a.height;surface.style.width=`min(100%, ${Math.round(520*a.width/a.height)}px)`;
  this.text('.inside-photo-caption',photo.caption);this.text('.inside-photo-count',String(this.photoIds.indexOf(this.photoId)+1).padStart(2,'0')+' / '+String(this.photoIds.length).padStart(2,'0'));
  this.$('.inside-photo-prev').hidden=this.$('.inside-photo-next').hidden=this.photoIds.length<2;
  this.$('.inside-all-photos').textContent='Все фотографии ('+this.allPhotoIds.length+') ↗';
  const thumbs=this.$('.inside-photo-thumbs');thumbs.replaceChildren();thumbs.hidden=false;
  this.photoIds.forEach(id=>{const p=this.getPhoto(id),b=document.createElement('button'),img=document.createElement('img');b.type='button';b.setAttribute('aria-label',p.caption);b.setAttribute('aria-pressed',String(id===this.photoId));setResponsive(img,p.assetId,'120px',true);img.alt='';img.loading='lazy';b.append(img);b.addEventListener('click',()=>{this.photoId=id;this.activeDetail=null;this.renderPhoto()});thumbs.append(b)});
  this.renderPoints();
 }
 renderPoints(){
  const asset=this.getPhoto(this.photoId)?.assetId,details=this.config.details.filter(x=>x.assetId===asset),toggle=this.$('.inside-toggle-points'),layer=this.$('.photo-points');
  toggle.hidden=!details.length;toggle.setAttribute('aria-pressed',String(!!this.showPoints));toggle.textContent=this.showPoints?'Скрыть решения':'Показать решения';layer.replaceChildren();layer.hidden=!this.showPoints;
  details.forEach((d,i)=>{const b=document.createElement('button');b.type='button';b.className='photo-point';b.style.left=d.x+'%';b.style.top=d.y+'%';b.dataset.detail=d.id;b.setAttribute('aria-label',d.title);b.setAttribute('aria-controls','photo-detail-card');b.setAttribute('aria-pressed',String(this.activeDetail===d.id));const n=document.createElement('span');n.textContent=String(i+1).padStart(2,'0');b.append(n);b.addEventListener('click',()=>{this.activeDetail=d.id;this.renderPoints();if(matchMedia('(max-width:700px)').matches)this.$('.photo-detail').scrollIntoView({behavior:this.motion(),block:'nearest'})});layer.append(b)});
  const detail=details.find(x=>x.id===this.activeDetail),card=this.$('.photo-detail');card.hidden=!detail||!this.showPoints;card.replaceChildren();if(!detail)return;
  const top=document.createElement('div');top.className='photo-detail-top';const meta=document.createElement('span');meta.className='micro';meta.textContent='ДЕТАЛЬ / РАЗБОР ПО ВИЗУАЛИЗАЦИИ';const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Закрыть пояснение');close.addEventListener('click',()=>{const id=this.activeDetail;this.activeDetail=null;this.renderPoints();this.$('.photo-point[data-detail="'+id+'"]').focus({preventScroll:true})});top.append(meta,close);card.append(top);
  const title=document.createElement('h4');title.textContent=detail.title;const desc=document.createElement('p');desc.className='photo-detail-description';desc.textContent=detail.description;card.append(title,desc,decisionDL(detail));
  if(detail.cropAssetId){const b=document.createElement('button');b.type='button';b.className='detail-reference';const im=document.createElement('img');setResponsive(im,detail.cropAssetId,'(max-width:700px) 100vw, 40vw');im.loading='lazy';im.alt=detail.title+' — связанный ракурс';const label=document.createElement('span');label.textContent='Связанный ракурс / открыть полностью ↗';b.append(im,label);b.addEventListener('click',()=>openPortfolioAsset(detail.cropAssetId));card.append(b)}
 }
 openSpecificDetail(detail){
  const photo=Object.entries(this.config.photos).find(([,p])=>p.assetId===detail.assetId);this.setMode('rooms');this.select(detail.roomId,{scroll:false});
  if(photo){const room=this.selected;if(!room.featured.includes(photo[0]))room.featured=[...room.featured.slice(0,3),photo[0]];this.photoId=photo[0];this.showPoints=true;this.activeDetail=detail.id;this.renderPhoto();}
  this.$('.inside-panel').scrollIntoView({behavior:this.motion(),block:'start'});
 }
 receiveGallery(){/* Browsing fullscreen deliberately leaves the plan/room/photo selection unchanged. */}
 bind(){
  super.bind();this.$('.inside-toggle-points').addEventListener('click',()=>{this.showPoints=!this.showPoints;if(!this.showPoints)this.activeDetail=null;this.renderPoints()});
  this.$('.inside-selection-reset').addEventListener('click',()=>{this.setMode('rooms');this.reset()});
  this.$('.inside-all-photos').addEventListener('click',()=>{const ids=this.allPhotoIds.map(id=>this.config.photos[id].assetId);openRoomCollection(this.mode==='rooms'?(this.selectedId||this.config.rooms[0].id):'all',ids,this.selected?.name||'Кухня-гостиная')});
 }
}
function decisionDL(data){const dl=document.createElement('dl');dl.className='decision-explanation';for(const [k,label] of [['task','Задача'],['solution','Решение'],['result','Результат']]){const div=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=data[k]||'';div.append(dt,dd);dl.append(div)}return dl}

const insideExplorer=new InsideExplorer2(document.querySelector('#architecture'),insideConfig,{
 image:assetId=>imagery[assetId],
 openPhoto:assetId=>{const keys=insideExplorer.allPhotoIds.map(id=>insideConfig.photos[id].assetId);showProject(projects.findIndex(p=>p.id===insideConfig.projectId),keys,assetId,insideExplorer.selected?.name||'Кухня-гостиная');openDialog(document.querySelector('#project-dialog'));},
 openDetail:id=>{setDetail(insideConfig.atlas[id]);document.querySelector('#details').scrollIntoView({behavior:insideExplorer.motion(),block:'start'});document.querySelector('[data-detail="'+insideConfig.atlas[id]+'"]').focus({preventScroll:true})}
});
document.addEventListener('itd:gallery-image',e=>{if(e.detail.projectId===insideConfig.projectId)insideExplorer.receiveGallery(e.detail.assetId)});
document.querySelector('#project-dialog').addEventListener('close',()=>{if(insideExplorer.state==='image-expanded')insideExplorer.setState(insideExplorer.selectedId?(insideExplorer.mode==='rooms'?'room-selected':'decision-selected'):'overview')});
document.querySelector('#project-inside-link').addEventListener('click',()=>{document.querySelector('#project-dialog').close();routeProject(projects[projectIndex].id,'inside')});


// Editorial entry points use stable gallery assets and preserve room state.
function openPortfolioAsset(asset){const p=projects.findIndex(project=>project.photos.some(photo=>photo[0]===asset));if(p<0)return;showProject(p,null,asset);openDialog($('#project-dialog'));}
$$('[data-portfolio-asset]').forEach(button=>button.addEventListener('click',()=>openPortfolioAsset(button.dataset.portfolioAsset)));
$('.atlas-open').addEventListener('click',()=>openPortfolioAsset(detailData[activeDetail].main));
$('.detail-open').addEventListener('click',()=>openPortfolioAsset(detailData[activeDetail].asset));
$$('[data-explore-room]').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();routeProject('baltiyskiy','inside');insideExplorer.setMode('rooms');insideExplorer.select(link.dataset.exploreRoom,{scroll:false});}));
$('#baltica-estimate').addEventListener('click',()=>{$('#area').value='73';$('#supervision').checked=false;choosePackage('max');});
setDetail(0);

// Automatic delivery through the configured form relay; confirmation is required.
const contactModal=$('#contact-dialog'),contactForm=$('#contact-form'),contactReady=$('#contact-ready');
let contactReturnFocus=null,contactRequestContext=null;
const contactSubmission=window.ITDForms.createSubmission();
function editContact(){contactForm.hidden=false;contactReady.hidden=true;$('#contact-feedback').textContent='';}
function openContact(trigger){
 if(contactSubmission.pending)return;
 contactReturnFocus=trigger;contactRequestContext=null;editContact();closeMenu();
 if(trigger.id==='calc-discuss'){
  const a=Number($('#area').value);if(Number.isFinite(a)&&a>0&&a<=100000)$('#contact-area').value=String(a);
  contactRequestContext={type:'estimate',pack:$('#package').value,supervision:$('#supervision').checked,months:$('#months').value,calculatorArea:a,calculatedTotal:$('#calc-total').textContent};
  $('#contact-form-context').textContent='Выбран пакет '+contactRequestContext.pack.toUpperCase()+($('#supervision').checked?' · авторский надзор: '+$('#months').value+' мес.':'')+'. Площадь можно изменить ниже.';
 }else if(trigger.id==='project-dialog-contact'){
  contactRequestContext={type:'portfolio',project:projects[projectIndex].name,frame:galleryItems[imageIndex][1]};
  $('#contact-form-context').textContent='Вас заинтересовал проект «'+contactRequestContext.project+'». Расскажите о своём объекте — подберём подходящий формат работы.';
 }
 $('#contact-form-context').hidden=!contactRequestContext;
 contactModal.showModal();document.body.style.overflow='hidden';contactModal.scrollTop=0;$('#contact-name').focus({preventScroll:true});
}
$$('[data-open-contact]').forEach(button=>button.addEventListener('click',e=>{e.preventDefault();openContact(button)}));
$('.contact-form-close').addEventListener('click',()=>contactModal.close());
let contactBackdropDown=false;
const outsideContact=e=>{const r=contactModal.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom};
contactModal.addEventListener('pointerdown',e=>{contactBackdropDown=e.target===contactModal&&outsideContact(e)});
contactModal.addEventListener('click',e=>{if(contactBackdropDown&&e.target===contactModal&&outsideContact(e))contactModal.close();contactBackdropDown=false});
contactModal.addEventListener('close',()=>{document.body.style.overflow=$$('dialog[open]').length?'hidden':'';if(contactReturnFocus?.isConnected)contactReturnFocus.focus({preventScroll:true});});
contactModal.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const items=[...contactModal.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);const first=items[0],last=items.at(-1);if(e.shiftKey&&(document.activeElement===first||!items.includes(document.activeElement))){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}});
const contactName=$('#contact-name'),contactPhone=$('#contact-phone-input');
function validateContact(){contactName.setCustomValidity(contactName.value.trim()?'':'Введите ваше имя.');const digits=contactPhone.value.replace(/\D/g,'');contactPhone.setCustomValidity(digits.length>=10&&digits.length<=15&&/^[+\d\s().-]+$/.test(contactPhone.value)?'':'Укажите номер телефона: от 10 до 15 цифр.');}
contactName.addEventListener('input',()=>contactName.setCustomValidity(''));contactPhone.addEventListener('input',()=>contactPhone.setCustomValidity(''));
contactPhone.addEventListener('blur',()=>{let d=contactPhone.value.replace(/\D/g,'');if(d.length===10)d='7'+d;if(d.length===11&&/^[78]/.test(d))contactPhone.value='+7 '+d.slice(1,4)+' '+d.slice(4,7)+'-'+d.slice(7,9)+'-'+d.slice(9);});
$('#contact-submit').addEventListener('click',validateContact);
contactForm.addEventListener('submit',async e=>{
 e.preventDefault();if(contactSubmission.pending)return;validateContact();if(!contactForm.reportValidity())return;
 const area=$('#contact-area').value,channel=contactForm.querySelector('[name="channel"]:checked').value,c=contactRequestContext;
 const payload={form_type:'calculation_request',name:contactName.value.trim(),phone:contactPhone.value.trim(),area:area?Number(area):'',contact_method:channel,consent:$('#contact-consent').checked,website:contactForm.elements.website.value,page_url:location.href};
 if(c?.type==='portfolio'){payload.project_name=c.project;payload.project_view=c.frame;payload.context={...c};}
 if(c?.type==='estimate'){
  payload.package=c.pack.toUpperCase();payload.calculator_area=c.calculatorArea;
  // Use the site's existing pricing rules, including the visitor's updated form area.
  if(area){const a=Number(area),discount=a>=200?400:a>=100?200:0;const amount=a<=30?rates[c.pack]*30:a*(rates[c.pack]-discount);payload.calculated_total=amount+(c.supervision?35000*Number(c.months):0);}
  payload.supervision=c.supervision?{selected:true,months:Number(c.months),monthly_from:35000}:false;
  payload.context={type:c.type,calculator_total_display:c.calculatedTotal};
 }
 const controls=[...contactForm.querySelectorAll('input,select,textarea,button')],wasDisabled=controls.map(el=>el.disabled),button=$('#contact-submit');
 controls.forEach(el=>{el.disabled=true});contactForm.setAttribute('aria-busy','true');button.textContent='Отправляем…';$('#contact-feedback').textContent='Отправляем заявку…';
 try{
  await contactSubmission.send(payload);
  contactForm.hidden=true;contactReady.hidden=false;contactModal.scrollTop=0;contactReady.querySelector('h3').focus({preventScroll:true});
 }catch{
  $('#contact-feedback').textContent='Не удалось отправить данные. Попробуйте ещё раз';
 }finally{
  controls.forEach((el,i)=>{el.disabled=wasDisabled[i]});contactForm.removeAttribute('aria-busy');button.textContent=contactForm.hidden?'Получить расчёт ↗':'Повторить отправку ↗';
 }
});
$('#contact-done-close').addEventListener('click',()=>contactModal.close());
// Shared project schema and renderer. Hash routes also work when index.html is opened locally.
const projectCatalog=window.ITD_PROJECTS;let currentCase=null,collectionRoom='all',collectionTheme='all',collectionLimit=9,collectionOverride=null;
const groupLabels={all:'Все ракурсы',composition:'Мебель и композиция',lighting:'Освещение',details:'Материалы и детали'};
function projectURL(id){return '#/projects/'+id}
function routeProject(id,section=''){const hash=projectURL(id)+(section?'/'+section:'');if(location.hash===hash)renderRoute();else location.hash=hash;}
function renderRoute(){
 const match=location.hash.match(/^#\/projects\/([^/]+)(?:\/(.*))?$/),p=match&&projectCatalog.find(p=>p.id===match[1]);
 if(match&&!p){location.replace('#projects');return;}
 for(const d of $$('dialog[open]'))d.close();
 if(!p){$('#top').hidden=false;$('#project-page').hidden=true;currentCase=null;document.title='ITD Studio — Интерьеры и детали';const anchor=location.hash&&location.hash!=='#/'?location.hash:'#top';requestAnimationFrame(()=>{const el=document.getElementById(anchor.slice(1));if(el)el.scrollIntoView({block:'start',behavior:'instant'})});return;}
 const changed=currentCase?.id!==p.id;currentCase=p;$('#top').hidden=true;$('#project-page').hidden=false;document.title=p.name+' — ITD / INSIDE';
 $('#case-title').textContent=p.name;$('#case-meta').textContent=p.meta;$('#case-number').textContent='ПРОЕКТ / '+String(projectCatalog.indexOf(p)+1).padStart(2,'0');$('#case-intro').textContent=p.intro;
 setResponsive($('#case-cover'),p.cover,'(max-width:700px) 100vw, 90vw');$('#case-cover').alt=p.name+' — '+p.gallery[0].caption;$('#case-cover').loading='eager';$('#case-cover').fetchPriority='high';
 if(p.plan&&insideConfig.projectId!==p.id){insideConfig=explorerConfig(p);insideExplorer.config=insideConfig;insideExplorer.viewId=insideConfig.viewId;insideExplorer.$('.inside-view-tabs').replaceChildren();insideExplorer.buildViews();insideExplorer.setMode('rooms')}$('#architecture').hidden=!p.plan;if(p.plan){$('.inside-project-line>span:last-child').textContent=p.name+' / '+p.parameters.area+' м²';$('.inside-plan-image').alt='Планировка — '+p.name;$('.inside-zoom-top>.micro').textContent=p.name.toUpperCase()+' / ПЛАНИРОВКА';$('[data-mode=rooms] span').textContent=String(p.rooms.length).padStart(2,'0');$('[data-mode=decisions]').hidden=!p.decisions.length;$('[data-mode=decisions] span').textContent=String(p.decisions.length).padStart(2,'0')}$('#case-explore').textContent=p.plan?'Исследовать пространство ↓':'Рассмотреть проект ↓';$('#case-explore').href=projectURL(p.id)+(p.plan?'/inside':'/gallery');
 const next=projectCatalog[(projectCatalog.indexOf(p)+1)%projectCatalog.length];$('#case-next').href=$('#case-next-top').href=projectURL(next.id);$('#case-next strong').textContent=next.name;
 if(changed){collectionRoom='all';collectionTheme='all';collectionLimit=9;collectionOverride=null;const select=$('#case-gallery-room');select.replaceChildren();const all=document.createElement('option');all.value='all';all.textContent='Все помещения';select.append(all);p.rooms.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.name;select.append(o)});select.parentElement.hidden=!p.rooms.length;renderCollection();}
 if(match[2]==='inside'&&p.plan){requestAnimationFrame(()=>$('#architecture').scrollIntoView({block:'start',behavior:'instant'}));}
 else if(match[2]==='gallery'){requestAnimationFrame(()=>$('#case-gallery').scrollIntoView({block:'start',behavior:'instant'}));}
 else if(changed||!match[2]){scrollTo(0,0);$('#case-title').focus({preventScroll:true})}
 if(p.plan&&!renderRoute.invited){renderRoute.invited=true;const marker=$('.inside-marker');const obs=new IntersectionObserver(entries=>{if(entries[0].isIntersecting){marker.classList.add('is-inviting');obs.disconnect()}},{threshold:.5});obs.observe(marker);}
}
function collectionPhotos(){let photos=currentCase.gallery;if(collectionOverride)photos=photos.filter(p=>collectionOverride.includes(p.assetId));else if(collectionRoom!=='all'){const room=currentCase.rooms.find(r=>r.id===collectionRoom),assets=room?.photos.map(id=>currentCase.photoRegistry[id].assetId)||[];photos=photos.filter(p=>assets.includes(p.assetId))}return photos;}
function renderCollection(){
 if(!currentCase)return;const all=collectionPhotos(),photos=collectionTheme==='all'?all:all.filter(p=>p.groups.includes(collectionTheme));
 const filters=$('#case-gallery-filters');filters.replaceChildren();for(const [id,label] of Object.entries(groupLabels)){const count=id==='all'?all.length:all.filter(p=>p.groups.includes(id)).length;if(!count)continue;const b=document.createElement('button');b.type='button';b.textContent=label+' '+count;b.dataset.group=id;b.setAttribute('aria-pressed',String(collectionTheme===id));b.addEventListener('click',()=>{collectionTheme=id;collectionLimit=9;renderCollection()});filters.append(b)}
 const room=currentCase.rooms.find(r=>r.id===collectionRoom);$('#case-gallery-title').textContent=room?room.name:'Пространство в ракурсах';$('#case-gallery-note').textContent=room?'Все опубликованные ракурсы помещения. Откройте изображение, чтобы рассмотреть его целиком.':'Общие виды и детали проекта. Фотографии открываются в полном разрешении.';$('#case-gallery-count').textContent=photos.length+' КАДРОВ';
 const grid=$('#case-gallery-grid');grid.replaceChildren();photos.slice(0,collectionLimit).forEach((photo,i)=>{const figure=document.createElement('figure');figure.className='case-photo';const button=document.createElement('button');button.type='button';button.setAttribute('aria-label','Открыть: '+photo.caption);const im=document.createElement('img');setResponsive(im,photo.assetId,'(max-width:700px) 45vw, 30vw');im.alt=photo.caption;im.loading='lazy';const arrow=document.createElement('span');arrow.textContent='↗';button.append(im,arrow);button.addEventListener('click',()=>openGalleryCollection(currentCase.id,photos.map(p=>p.assetId),photo.assetId,room?.name||'Все помещения'));const cap=document.createElement('figcaption'),num=document.createElement('span');num.textContent=String(i+1).padStart(2,'0');cap.append(num,document.createTextNode(photo.caption));figure.append(button,cap);grid.append(figure)});
 $('#case-gallery-more').hidden=photos.length<=collectionLimit;$('#case-gallery-more').textContent='Показать все '+photos.length+' фотографии ↓';
}
function openRoomCollection(room,assets,label){
 if(currentCase?.id!==insideConfig.projectId){routeProject(insideConfig.projectId,'gallery');requestAnimationFrame(()=>openRoomCollection(room,assets,label));return;}
 collectionRoom=room;collectionOverride=room==='all'?assets:null;collectionTheme='all';collectionLimit=100;$('#case-gallery-room').value=room;renderCollection();if(room==='all'&&label)$('#case-gallery-title').textContent=label;$('#case-gallery').scrollIntoView({behavior:insideExplorer.motion(),block:'start'});
}
function openGalleryCollection(id,assets,first,label){const n=projects.findIndex(p=>p.id===id);showProject(n,assets,first,label);openDialog($('#project-dialog'));}
$('#case-gallery-room').addEventListener('change',e=>{collectionRoom=e.target.value;collectionOverride=null;collectionTheme='all';collectionLimit=9;renderCollection()});
$('#case-gallery-more').addEventListener('click',()=>{collectionLimit=100;renderCollection()});
$('.case-hero-photo').addEventListener('click',()=>openGalleryCollection(currentCase.id,null,currentCase.cover,'Все помещения'));
$('#case-contact-button').addEventListener('click',()=>{openContact($('#case-contact-button'));contactRequestContext={type:'portfolio',project:currentCase.name,frame:'Страница проекта'};$('#contact-form-context').hidden=false;$('#contact-form-context').textContent='Вас заинтересовал проект «'+currentCase.name+'». Обсудим похожую задачу для вашего пространства.'});
window.addEventListener('hashchange',renderRoute);renderRoute();

})();

