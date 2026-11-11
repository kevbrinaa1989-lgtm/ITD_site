"use strict";
(() => {
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const labels = {planned:"Не начат",in_progress:"В работе",pending_approval:"Нужно решение",changes_requested:"На доработке",approved:"Согласован",completed:"Завершён"};
  const active = project => !["Архив", "Завершён"].includes(project.status);
  const materialTitle = value => String(value || "Материал").replace(/\.(pdf|jpe?g|png|webp|gif|svg|dwg|dxf|docx?|xlsx?|pptx?|txt|zip|rar|7z)$/i, "");
  function button(text, action, cls="text-button") {
    const b=node("button",text,cls);b.type="button";
    b.addEventListener("click",()=>Promise.resolve().then(action).catch(error=>{
      const message=document.getElementById("status-message");message.textContent=error.message;message.classList.add("is-error");
    }));return b;
  }
  function date(value){if(!value)return "";const [y,m,d]=value.slice(0,10).split("-").map(Number);return new Date(y,m-1,d).toLocaleDateString("ru-RU",{day:"numeric",month:"long"});}
  function progress(project){const stages=project.stages||[],done=stages.filter(s=>s.status==="completed").length;const box=node("div",undefined,"route-progress");const meta=node("div",undefined,"route-progress-meta");meta.append(node("span","Готовность проекта"),node("strong",stages.length?Math.round(done/stages.length*100)+"%":"—"));const bar=node("progress");bar.max=stages.length||1;bar.value=done;bar.setAttribute("aria-label",`Завершено ${done} из ${stages.length} этапов`);box.append(meta,bar);return box;}
  function journey(project, actions){
    const root=node("div",undefined,"project-journey"),stages=project.stages||[],files=project.files||[];
    const underway=stages.filter(s=>["in_progress","pending_approval","changes_requested"].includes(s.status));
    const waiting=active(project)?files.filter(f=>f.review?.isCurrent&&f.review.status==="pending_approval"):[];
    const chosen=waiting[0]||files.filter(f=>(!f.review||f.review.isCurrent)&&window.ITDViewer?.image(f)).at(-1);
    const stage=stages.find(s=>s.id===chosen?.stageId)||underway[0]||stages.find(s=>s.status!=="completed");
    const strip=node("div",undefined,"route-strip");strip.setAttribute("aria-label","Маршрут проекта");
    stages.forEach((s,i)=>{const b=button("",()=>actions.openStage(s.id),"route-step");b.dataset.status=s.status;b.classList.toggle("is-current",s.id===stage?.id);b.append(node("strong",String(i+1).padStart(2,"0")));const text=node("span",s.title);text.append(node("small",labels[s.status]||s.status));b.append(text);strip.append(b)});
    if(stages.length)root.append(strip);else root.append(node("p","Этапы проекта появятся после подготовки плана студией.","empty-note"));
    const card=node("section",undefined,"route-feature"),head=node("div",undefined,"route-feature-head");
    const stageHeading=node("div",undefined,"route-stage-heading");stageHeading.append(node("span",stage?String(stages.indexOf(stage)+1).padStart(2,"0"):"—","route-stage-number"));const title=node("div");title.append(node("p",active(project)?"Сейчас в проекте":"История проекта","eyebrow"),node("h2",stage?.title||project.status));stageHeading.append(title);head.append(stageHeading,node("span",waiting.length?`Решений от вас: ${waiting.length}`:active(project)?"Решений не требуется":project.status,"badge"));card.append(head);
    const body=node("div",undefined,"route-feature-body");
    if(chosen&&window.ITDViewer?.image(chosen)){const image=window.ITDViewer.thumbnail(chosen,files);image.className="route-feature-image";body.append(image)}else{const placeholder=node("div",undefined,"route-feature-placeholder");placeholder.append(node("span",stage?String(stages.indexOf(stage)+1).padStart(2,"0"):"ITD"),node("p",chosen?"Документ проекта":"От идеи — к пространству"));body.append(placeholder)}
    const copy=node("div",undefined,"route-feature-copy");copy.append(node("p",waiting.length?"Следующий шаг":"Ваш проект","eyebrow"),node("h3",chosen?materialTitle(chosen.name):stage?.title||"Всё по порядку"));
    copy.append(node("p",waiting.length?"Посмотрите текущую версию и сообщите, всё ли вам подходит.":stage?.description||"Все доступные материалы и документы собраны в разделах проекта.","muted"));
    if(stage?.plannedEndDate)copy.append(node("p","Срок этапа — "+date(stage.plannedEndDate),"route-deadline"));
    if(chosen?.review)copy.append(button(waiting.length?"Посмотреть и решить →":"Открыть материал →",()=>actions.openMaterial(chosen),"primary"),node("p",`Версия ${chosen.review.versionNumber} · ${chosen.name}`,"file-meta"));
    else copy.append(button(chosen?"Смотреть материалы →":"Открыть этапы →",()=>actions.openTab(chosen?"results":"stages"),"primary"));
    body.append(copy);card.append(body);root.append(card);
    for(const s of underway.filter(s=>s.id!==stage?.id)){const parallel=button("",()=>actions.openStage(s.id),"route-parallel");parallel.append(node("span",String(stages.indexOf(s)+1).padStart(2,"0")),node("strong",s.title),node("small",(underway.length>1?"Параллельно · ":"")+(labels[s.status]||s.status)));root.append(parallel)}
    const links=node("div",undefined,"route-links");for(const [title,description,tab] of [["Альбом проекта","Визуализации, ракурсы и детали интерьера","results"],["Документы","Договоры и файлы вашего проекта","documents"]]){const item=node("section",undefined,"panel");item.append(node("h2",title),node("p",description,"muted"),button("Открыть →",()=>actions.openTab(tab)));links.append(item)}root.append(links);return root;
  }
  let shellUser=null,shellTab=null,selectTab=null;
  function closeMenu(){document.body.classList.remove("menu-open");document.getElementById("mobile-menu-button")?.setAttribute("aria-expanded","false");}
  function placeNavigation(){const nav=document.getElementById("studio-navigation"),host=document.getElementById("shell-navigation-host"),sidebar=document.querySelector(".project-sidebar");if(!nav||!host)return;const horizontal=shellUser?.role==="client"&&matchMedia("(min-width: 1101px)").matches;if(horizontal)host.append(nav);else sidebar.insertBefore(nav,sidebar.querySelector(".sidebar-bottom"));nav.setAttribute("aria-orientation",horizontal?"horizontal":"vertical");}
  function syncShell(user,tab,inProject,select){shellUser=user;shellTab=tab;selectTab=select;document.body.dataset.role=user?.role||"guest";document.body.dataset.section=tab||"";document.body.classList.toggle("authenticated",!!user);placeNavigation();const bottom=document.getElementById("mobile-bottom-nav");if(!bottom)return;bottom.replaceChildren();if(!user)return;const items=user.role==="admin"?[["Главная","workspace","◫"],["Проекты","projects","▦"],["Клиенты","clients","♙"],["Задачи","tasks","≡"]]:[["Главная","client-home","⌂"],["Проекты","client-projects","▦"],["Решения","client-review","✓"],["Профиль","profile","○"]];for(const[label,key,icon]of items){const b=button("",()=>select(key));b.dataset.shellTab=key;b.setAttribute("aria-current",tab===key||(inProject&&key.endsWith("projects"))?"page":"false");b.append(node("span",icon),node("small",label));bottom.append(b)}}
  function toggleMenu(){const open=!document.body.classList.contains("menu-open");document.body.classList.toggle("menu-open",open);document.getElementById("mobile-menu-button").setAttribute("aria-expanded",String(open));if(open)document.querySelector("#studio-navigation button:not([hidden])")?.focus()}
  document.addEventListener("keydown",e=>{if(!document.body.classList.contains("menu-open"))return;if(e.key==="Escape"){closeMenu();document.getElementById("mobile-menu-button")?.focus()}if(e.key==="Tab"){const controls=[...document.querySelectorAll('.project-sidebar a,.project-sidebar button,#mobile-menu-button')].filter(n=>n.getClientRects().length&&!n.disabled),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}});
  window.addEventListener("resize",()=>{placeNavigation();if(innerWidth>1100)closeMenu()});
  document.addEventListener("DOMContentLoaded",()=>document.getElementById("shell-menu-backdrop")?.addEventListener("click",()=>{closeMenu();document.getElementById("mobile-menu-button").focus()}));
  window.ITDUI={node,button,active,materialTitle,date,progress,journey,syncShell,toggleMenu};
})();
