import { dayKey, buildDaySlots } from './schedule.js';
(() => {
  'use strict';
  const ZONE = 'Europe/Kyiv';
  const $ = id => document.getElementById(id);
  const state = { day: 0, group: '1', status: null, groups: [], entries: [], raw: {}, loading: false };

  const apiUrl = path => new URL(path, location.origin).href;
  const displayDate = day => new Intl.DateTimeFormat('uk-UA',{timeZone:ZONE,day:'numeric',month:'long',weekday:'long'}).format(new Date(`${day}T12:00:00Z`));
  const timeLocal = v => new Intl.DateTimeFormat('uk-UA',{timeZone:ZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v));
  const dateTimeLocal = v => new Intl.DateTimeFormat('uk-UA',{timeZone:ZONE,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v));
  const pluralHours = minutes => (minutes / 60).toLocaleString('uk-UA',{maximumFractionDigits:1}) + ' год';
  const extractGroups = payload => Array.isArray(payload?.groups) ? payload.groups : [];
  const extractEntries = payload => Array.isArray(payload?.schedule) ? payload.schedule : [];
  const groupNumber = g => String(g.groupNumber);
  const groupLabel = g => `Черга ${g.groupNumber}`;
  const labelFor = s => ({on:'Світло є',off:'Відключення',maybe:'Можливе відключення',unknown:'Немає даних'})[s];
  let scheduleRequest = 0;

  async function requestJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(apiUrl(path),{headers:{'Accept':'application/json'},cache:'no-store',signal:controller.signal});
      const body = await response.text();
      let data;
      try { data = JSON.parse(body); } catch { throw new Error(`${path}: відповідь не JSON (HTTP ${response.status})`); }
      if (!response.ok && !(path === '/api/status' && response.status === 503 && data.status === 'waiting')) throw new Error(`${path}: HTTP ${response.status} — ${JSON.stringify(data).slice(0,250)}`);
      return data;
    } finally { clearTimeout(timer); }
  }
  function showError(message) { $('error').style.display = 'block'; $('error').textContent = message; }
  function clearError() { $('error').style.display = 'none'; $('error').textContent = ''; }
  function updateLinks() {
    $('statusLink').href=apiUrl('/api/status');
    $('groupsLink').href=apiUrl('/api/groups');
    $('scheduleLink').href=apiUrl(`/api/schedule?group=${encodeURIComponent(state.group)}`);
  }
  function renderStatus() {
    const data=state.status||{};
    const v=String(data.status??data.state??'unknown').toLowerCase();
    $('statusValue').textContent={ok:'Працює',stale:'Застарілий',waiting:'Очікування',unavailable:'Недоступний',unknown:'Невідомо'}[v]||v;
    $('statusMinor').textContent=v==='stale'?'Кеш не оновлювався вчасно':v==='ok'?'Кеш доступний':(data.message||'Перевірка джерела');
    $('liveLabel').textContent=v==='ok'?'API online':v==='stale'?'Дані застаріли':v==='waiting'?'Немає даних':v==='unavailable'?'API недоступний':v;
    $('liveDot').className='dot '+(v==='ok'?'ok':v==='stale'?'stale':'error');
    const updated=data.updated_at??data.updatedAt??data.last_updated??data.fetchedAt;
    $('updatedValue').textContent=updated && Number.isFinite(Date.parse(updated))?timeLocal(updated):'—';
    $('updatedMinor').textContent=updated && Number.isFinite(Date.parse(updated))?dateTimeLocal(updated)+' · Київ':'Europe/Kyiv';
    $('groupsValue').textContent=(data.groups ?? state.groups.length) || '—';
    $('entriesValue').textContent=(data.entries ?? state.entries.length) || '—';
    $('sourceMinor').textContent='Кешовані дані · оновлення кожні 15 хв';
  }
  function renderGroups() {
    const s=$('group'); s.replaceChildren();
    if (!state.groups.length) {
      for(let i=1;i<=12;i++){const option=new Option(`Черга ${i}`,String(i));s.add(option);}
    } else {
      state.groups.forEach((g,i)=>{const option = new Option(groupLabel(g,i),groupNumber(g,i));s.add(option);});
    }
    if ([...s.options].some(o=>o.value===state.group)) s.value=state.group;
    else { state.group=s.value; }
    updateLinks();
  }
  function renderSchedule() {
    const target=dayKey(state.day);
    $('scheduleHeading').textContent=displayDate(target);
    $('scheduleLabel').textContent=`Черга ${state.group} · ${target}`;
    const intervals=buildDaySlots(target,state.entries);
    const slots=intervals.map(slot=>slot.state);
    const knownCount=slots.filter(slot=>slot!=='unknown').length;
    const count = key => slots.filter(s=>s===key).length;
    const total = s=>knownCount ? pluralHours(count(s)*30) : '—';
    $('offTotal').textContent='Без світла: '+total('off');
    $('onTotal').textContent='Зі світлом: '+total('on');
    $('maybeTotal').textContent='Можливо: '+total('maybe');
    $('chartHint').textContent='Час: Europe/Kyiv. Кожна клітинка — 30 хвилин.'+(slots.length!==48?' Перехід літнього/зимового часу: день має '+slots.length/2+' год.':'');
    $('intervalCount').textContent=`${knownCount} із ${slots.length} слотів`;
    const area=$('chartArea');area.replaceChildren();
    if (!state.entries.length) {
      const empty=document.createElement('div');empty.className='empty';empty.textContent='Графік відсутній або формат відповіді ще не підтримується. Перевір JSON нижче.';area.append(empty);
      $('events').replaceChildren();return;
    }
    if (!knownCount) {
      const empty=document.createElement('div');empty.className='empty';empty.textContent=`На ${target} немає даних для відображення. Спробуй інший день.`;area.append(empty);
    }
    const wrap=document.createElement('div');wrap.className='timeline-wrap';
    const tl=document.createElement('div');tl.className='timeline';tl.setAttribute('role','img');tl.setAttribute('aria-label','Графік відключень по 30 хвилин');
    const now = Date.now();
    tl.style.gridTemplateColumns=`repeat(${slots.length},minmax(11px,1fr))`;
    slots.forEach((slot,i)=>{
      const item=document.createElement('div');item.className='slot';item.dataset.state=slot;
      item.title=`${intervals[i].from}–${intervals[i].to} · ${labelFor(slot)}`;
      if(now>=intervals[i].start && now<intervals[i].end)item.classList.add('now');
      tl.append(item);
    });
    wrap.append(tl);
    const ruler=document.createElement('div');ruler.className='times';
    [...intervals.filter((_,i)=>i%6===0).map(slot=>slot.from),'24:00'].forEach(t=>{const span=document.createElement('span');span.textContent=t;ruler.append(span);});
    wrap.append(ruler);area.append(wrap);
    const groups=[];
    for(let i=0;i<slots.length;i++){
      if (!groups.length || groups[groups.length-1].state!==slots[i]) groups.push({state:slots[i],from:i,to:i+1});
      else groups[groups.length-1].to=i+1;
    }
    const events=$('events');events.replaceChildren();
    groups.filter(g=>g.state!=='unknown').forEach(g=>{
      const e=document.createElement('div');e.className='event';
      const left=document.createElement('div');
      const title=document.createElement('div');title.className='event-title';title.textContent=`${intervals[g.from].from}–${intervals[g.to-1].to}`;
      const duration=document.createElement('div');duration.className='event-times';duration.textContent=pluralHours((g.to-g.from)*30);
      left.append(title,duration);
      const tag=document.createElement('div');tag.className='state-tag '+g.state;tag.textContent=labelFor(g.state);
      e.append(left,tag);events.append(e);
    });
    if(!events.childElementCount){const empty=document.createElement('div');empty.className='empty';empty.textContent='Підтверджених інтервалів немає';events.append(empty);}
  }
  function renderRaw() { $('rawJson').textContent=JSON.stringify(state.raw,null,2).slice(0,90000); }
  async function loadAll() {
    if(state.loading)return;
    state.loading=true;$('reload').disabled=true;clearError();
    let messages=[];
    try {
      const result=await Promise.allSettled([requestJson('/api/status'),requestJson('/api/groups')]);
      if(result[0].status==='fulfilled') {state.status=result[0].value;state.raw.status=state.status;} else {state.status={status:'unavailable',message:'Не вдалося перевірити стан API'};messages.push('Status: '+result[0].reason.message);}
      if(result[1].status==='fulfilled') {state.groups=extractGroups(result[1].value);state.raw.groups=result[1].value;} else {state.groups=[];messages.push('Groups: '+result[1].reason.message);}
      renderGroups();renderStatus();
      await loadSchedule(false);
    } catch(error) { messages.push(error.message); }
    finally {state.loading=false;$('reload').disabled=false;}
    if(messages.length)showError(messages.join('\n'));
  }
  async function loadSchedule(resetError=true) {
    if(resetError)clearError();
    updateLinks();
    const requestId=++scheduleRequest;
    const requestedGroup=state.group;
    state.entries=[];renderSchedule();
    $('chartArea').textContent='Завантаження графіка…';
    try {
      let result=await requestJson(`/api/schedule?group=${encodeURIComponent(state.group)}`);
      if(requestId!==scheduleRequest || requestedGroup!==state.group)return;
      let entries=extractEntries(result);
      // Some backends return all groups in one payload; filter using known IDs if possible.
      const g=state.groups.find((value,i)=>groupNumber(value,i)===state.group);
      const internalId=g&&typeof g==='object'?g.id:undefined;
      if (entries.some(v=>v.groupId!==undefined) && internalId!==undefined) {
        entries=entries.filter(v=>String(v.groupId)===String(internalId));
      }
      state.entries=entries;
      state.raw.schedule=result;
      delete state.raw.scheduleError;
      renderStatus();renderSchedule();renderRaw();
    } catch(error) {
      if(requestId!==scheduleRequest || requestedGroup!==state.group)return;
      state.entries=[];renderSchedule();
      state.raw.scheduleError=error.message;renderRaw();
      showError('Schedule: '+error.message + '\nЯкщо API відповідає іншими полями, відкрий JSON нижче та звір структуру.');
    }
  }
  $('reload').addEventListener('click',loadAll);
  $('group').addEventListener('change',()=>{state.group=$('group').value;loadSchedule();});
  document.querySelectorAll('[data-day]').forEach(button=>button.addEventListener('click',()=>{
    state.day=Number(button.dataset.day);
    document.querySelectorAll('[data-day]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
    renderSchedule();
  }));

  setInterval(loadAll,5*60*1000);
  updateLinks();loadAll();
})();
