
(() => {
  'use strict';
  const submission = window.ITDForms.createSubmission();
  const form = document.getElementById('design-form');
  const steps = [...document.querySelectorAll('.step')];
  const progress = document.getElementById('progress');
  const count = document.getElementById('step-number');
  const feedback = document.getElementById('form-feedback');
  const done = document.getElementById('form-done');
  const next = document.getElementById('next');
  const prev = document.getElementById('prev');
  let current = 0;
  const stepLabels = ['Об объекте', 'Образ жизни', 'Пожелания', 'Услуги и сроки', 'Контакты'];

  function setStep(i){
    current=Math.max(0, Math.min(i,steps.length-1));
    steps.forEach((step,j)=>{step.hidden=j!==current;step.setAttribute('aria-hidden',String(j!==current));});
    count.textContent=String(current+1).padStart(2,'0')+' / '+String(steps.length).padStart(2,'0');
    progress.style.width=((current+1)/steps.length*100)+'%';
    prev.hidden=current===0;
    next.innerHTML=(current===steps.length-1 ? 'Отправить анкету' : 'Продолжить')+' <span class="arrow" aria-hidden="true">↗</span>';
    feedback.textContent='';
    document.title='Анкета — '+stepLabels[current]+' | ITD Studio';
    document.getElementById('form-head').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});
  }
  function validate(){
    const controls=[...steps[current].querySelectorAll('input,textarea,select')].filter(c=>!c.disabled && (c.required || c.type==='email'));
    for(const c of controls){
      if(!c.checkValidity()){
        feedback.textContent = c.validity.valueMissing ? 'Пожалуйста, заполните обязательное поле.' : 'Проверьте правильность введённых данных.';
        c.focus(); return false;
      }
    }
    if(current===steps.length-1){
      const consent=document.querySelector('#agreement');
      if(!consent.checked){feedback.textContent='Подтвердите согласие на обработку персональных данных.';consent.focus();return false;}
    }
    return true;
  }
  const prompts = {
    object_type:'Тип объекта', object_address:'Адрес или ЖК', area:'Площадь, м²', rooms:'Комнаты / санузлы', stage:'Стадия объекта', docs:'Документы на объект',
    residents:'Кто будет пользоваться пространством',pets:'Домашние животные',needs:'Пожелания к планировке',styles:'Стили',likes:'Нравится / не нравится',redev:'Перепланировка',
    services:'Услуги',budget:'Бюджет на ремонт и мебель',start:'Планируемое начало',comments:'Дополнительные пожелания',name:'Имя',phone:'Телефон',email:'Email',method:'Предпочтительный способ связи'
  };
  const getValues = () => {
    const data={}, fd=new FormData(form);
    Object.keys(prompts).forEach(k=>{
      const val=fd.getAll(k).map(String).map(s=>s.trim()).filter(Boolean);
      const multiple=[...form.querySelectorAll('[name="'+k+'"]')].some(c=>c.type==='checkbox');
      data[k]=multiple?val:(val.length>1?val:(val[0]||''));
    });
    return data;
  };
  const format=data=>'Анкета ITD Studio\n\n'+Object.entries(prompts).map(([k,label])=>label+': '+(Array.isArray(data[k])?data[k].join(', '):data[k]||'—')).join('\n');
  next.addEventListener('click',async ()=>{
    if(submission.pending||!validate())return;
    if(current<steps.length-1){setStep(current+1);return;}
    // Recheck previous steps before sending; their existing validation rules are retained.
    for(let i=0;i<steps.length;i++){
      const invalid=[...steps[i].querySelectorAll('input,select,textarea')].find(c=>!c.disabled&&!c.checkValidity());
      if(invalid){setStep(i);feedback.textContent='Проверьте обязательные поля.';invalid.focus();return;}
    }
    const answers=getValues();
    const payload={form_type:'design_questionnaire',name:answers.name,phone:answers.phone,email:answers.email,contact_method:answers.method,object_type:answers.object_type,area:answers.area,styles:answers.styles,services:answers.services,answers_json:answers,answers_text:format(answers),page_url:location.href,consent:document.getElementById('agreement').checked,website:form.elements.website.value};
    const controls=[...form.querySelectorAll('input,textarea,select,button')],wasDisabled=controls.map(c=>c.disabled);
    controls.forEach(c=>{c.disabled=true});form.setAttribute('aria-busy','true');next.textContent='Отправляем…';feedback.textContent='Отправляем анкету…';
    try{
      await submission.send(payload);
      form.hidden=true;done.hidden=false;done.scrollIntoView({behavior:'smooth',block:'start'});
    }catch{
      feedback.textContent='Не удалось отправить данные. Попробуйте ещё раз';
    }finally{
      controls.forEach((c,i)=>{c.disabled=wasDisabled[i]});form.removeAttribute('aria-busy');next.textContent=form.hidden?'Отправить анкету ↗':'Повторить отправку ↗';
    }
  });
  prev.addEventListener('click',()=>{if(!submission.pending)setStep(current-1)});
  // Avoid regular form submission; the site does not invent success responses.
  form.addEventListener('submit',e=>e.preventDefault());
  steps.forEach((step,i)=>{step.querySelectorAll('input,select,textarea').forEach(input=>input.addEventListener('keydown',e=>{
    if(e.key==='Enter' && e.target.tagName!=='TEXTAREA' && e.target.type!=='radio' && e.target.type!=='checkbox'){
      e.preventDefault(); if(current<steps.length-1)next.click();
    }
  }));});
  setStep(0);
})();
