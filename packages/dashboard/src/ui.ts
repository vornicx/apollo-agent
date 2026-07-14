/**
 * The Apollo dashboard SPA — a single self-contained document (no build step,
 * no framework, no web fonts, works offline). It renders whatever the JSON API
 * and the SSE stream provide: it holds no state of its own beyond what it
 * fetches. Design language: near-black instrument panel, one warm accent
 * (Apollo, the sun), monospace for data, density with purpose.
 */
export function renderHtml(): string {
  return DOCUMENT;
}

// Vanilla client. Written with quotes + concatenation only (no backticks, no
// template-literal interpolation) so it lives cleanly inside the outer HTML
// template literal below.
const CLIENT_SCRIPT = `
'use strict';
var CAPS = [['code','code'],['reasoning','rsn'],['writing','wrt'],['vision','vis'],['tool-use','tool'],['long-context','ctx']];
var state = { runs: [], models: [], missions: [], selected: null, diffIds: [], searchQ: '' };
var liveTimer = null;

function el(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function api(path){ return fetch(path).then(function(r){ return r.json(); }); }
function apiPost(path, body){
  return fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body||{}) })
    .then(function(r){ return r.json().then(function(data){ if(!r.ok) throw new Error(data.error||('HTTP '+r.status)); return data; }); });
}
function money(n){ return '$' + (Number(n)||0).toFixed(4); }
function dur(ms){ ms = Number(ms)||0; return ms < 1000 ? Math.round(ms) + 'ms' : (ms/1000).toFixed(1) + 's'; }
function when(ts){
  if(!ts) return '';
  var d = Date.now() - ts;
  if(d < 60000) return Math.max(1, Math.round(d/1000)) + 's ago';
  if(d < 3600000) return Math.round(d/60000) + 'm ago';
  if(d < 86400000) return Math.round(d/3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

/* ---- views ---- */
function switchView(name){
  var items = document.querySelectorAll('.navitem');
  for(var i=0;i<items.length;i++){ items[i].classList.toggle('active', items[i].getAttribute('data-view') === name); }
  var views = document.querySelectorAll('.view');
  for(var j=0;j<views.length;j++){ views[j].classList.toggle('active', views[j].id === 'view-' + name); }
  var titles = { missions:'Missions', runs:'Runs', fleet:'Fleet', about:'About' };
  el('vtitle').textContent = titles[name] || name;
  el('vsub').textContent = name === 'fleet' ? state.models.length + ' models configured'
    : name === 'runs' ? state.runs.length + ' recorded runs' : '';
}

/* ---- mission control ---- */
function loadMissionControl(){
  return api('/api/control').then(function(data){
    state.missions = data.missions || [];
    renderMissions(data);
  });
}

function renderMissions(data){
  var enabled = Boolean(data && data.enabled);
  el('mission-disabled').style.display = enabled ? 'none' : 'block';
  var rows = state.missions.map(function(m){
    var actions = m.status === 'running'
      ? '<button class="danger" data-action="cancel" data-id="'+esc(m.id)+'">Cancel</button>'
      : '<button data-action="retry" data-id="'+esc(m.id)+'">Retry</button>';
    if(m.status === 'stopped' || m.status === 'needs_input') actions += '<button class="gold-btn" data-action="clarify" data-id="'+esc(m.id)+'">Answer & retry</button>';
    return '<div class="mission-row"><span class="sdot '+(m.status==='succeeded'?'succeeded':(m.status==='running'||m.status==='needs_input')?'incomplete':'failed')+'"></span>'+
      '<div class="mission-main"><div class="mission-goal">'+esc(m.goal).slice(0,240)+'</div>'+
      (m.answer ? '<div class="mission-answer">'+esc(m.answer).slice(0,1200)+'</div>' : '')+
      '<div class="mission-meta mono">'+esc(m.id)+' · '+esc(m.workspace)+' · '+esc(m.status)+(m.verificationPassed===true?' · verified':'')+'</div></div>'+
      '<div class="mission-actions">'+actions+'</div></div>';
  }).join('');
  el('mission-list').innerHTML = rows || '<div class="empty">No missions yet. Describe an outcome above.</div>';
}

function submitMission(e){
  e.preventDefault();
  var button = el('mission-submit');
  button.disabled = true; button.textContent = 'Starting…';
  el('mission-error').textContent = '';
  apiPost('/api/missions', {
    goal: el('mission-goal').value,
    workspace: el('mission-workspace').value,
    approve: el('mission-approve').checked,
    noMemory: !el('mission-memory').checked,
    check: el('mission-check').value
  }).then(function(){
    el('mission-goal').value = '';
    return loadMissionControl();
  }).catch(function(error){ el('mission-error').textContent = error.message; })
    .finally(function(){ button.disabled=false; button.textContent='Start mission'; });
}

function missionAction(e){
  var button = e.target.closest ? e.target.closest('button[data-action]') : null;
  if(!button) return;
  var id = button.getAttribute('data-id'); var action = button.getAttribute('data-action');
  var clarification = '';
  if(action === 'clarify') clarification = window.prompt('What does Apollo need to know before retrying?') || '';
  var endpoint = '/api/missions/'+encodeURIComponent(id)+'/'+(action === 'cancel' ? 'cancel' : 'retry');
  apiPost(endpoint, clarification ? {clarification:clarification} : {}).then(loadMissionControl)
    .catch(function(error){ el('mission-error').textContent = error.message; });
}

function renderHealth(h){
  var d = h.diagnostics || {};
  el('health').innerHTML = '<span class="health-ok">● runtime '+esc(h.runtime)+'</span><span>'+esc(h.version)+'</span><span>'+esc(h.node)+'</span><span>'+esc(h.models)+' models</span><span>'+(d.providers||[]).length+' live providers</span><span>Midas '+(d.memoryConfigured?'configured':'off')+'</span><span>'+esc(d.configPath||'no config')+'</span><span>'+esc(h.stateDir||'')+'</span>';
  if(d.workspace) el('mission-workspace').value = d.workspace;
}

function renderStats(s){
  var providers = (s.byProvider || []).length;
  var rate = s.runs ? Math.round((s.successRate||0)*100) + '%' : '—';
  var cards = [
    ['Runs recorded', String(s.runs||0), '', ''],
    ['Success rate', rate, 'green', (s.succeeded||0) + ' ok · ' + (s.failed||0) + ' failed'],
    ['Total cost', money(s.totalCostUsd), 'gold', 'real usage-based'],
    ['Providers used', String(providers), '', (s.byProvider||[]).map(function(p){return p.provider;}).slice(0,3).join(', ')]
  ];
  el('stats').innerHTML = cards.map(function(c){
    return '<div class="stat"><div class="label">'+c[0]+'</div><div class="v '+c[1]+'">'+c[2]+'</div><div class="sub2">'+esc(c[3])+'</div></div>';
  }).join('');
}

/* ---- search ---- */
function filterRuns(runs){
  var q = state.searchQ.toLowerCase();
  if(!q) return runs;
  return runs.filter(function(r){
    return (r.id||'').toLowerCase().indexOf(q) !== -1 ||
      (r.title||'').toLowerCase().indexOf(q) !== -1 ||
      (r.finalModel||'').toLowerCase().indexOf(q) !== -1 ||
      (r.status||'').toLowerCase().indexOf(q) !== -1;
  });
}

function renderRuns(data){
  var runs = Array.isArray(data) ? data : (data && data.runs ? data.runs : data);
  state.runs = Array.isArray(runs) ? runs : [];
  renderRunsTable();
}

function renderRunsTable(){
  var runs = filterRuns(state.runs);
  if(!state.runs.length){
    el('runspanel').innerHTML = '<div class="empty">No recorded runs yet.<br>Run <span class="mono">apollo run</span> or <span class="mono">apollo demo</span> — every run records here.</div>';
    return;
  }
  if(!runs.length){
    el('runspanel').innerHTML = '<div class="empty">No runs match <span class="mono">'+esc(state.searchQ)+'</span>.</div>';
    return;
  }
  var head = '<table><thead><tr><th class="cmp-col"></th><th></th><th>Run</th><th>Task</th><th>Model</th><th class="right">Att</th><th class="right">Cost</th><th class="right">Time</th><th class="right">When</th></tr></thead><tbody>';
  var rows = runs.map(function(r){
    var model = r.finalModel ? r.finalModel : '—';
    var esc_id = esc(r.id);
    var isSel = state.diffIds.indexOf(r.id) !== -1;
    var chk = '<span class="cmp-btn' + (isSel ? ' cmp-on' : '') + '" title="Select for diff" data-cmpid="'+esc_id+'">&#x25C9;</span>';
    return '<tr data-id="'+esc_id+'">' +
      '<td class="cmp-col" data-cmpid="'+esc_id+'">'+chk+'</td>' +
      '<td><span class="sdot '+r.status+'"></span></td>' +
      '<td class="num mut">'+esc_id+'</td>' +
      '<td>'+esc((r.title||'').slice(0,46))+'</td>' +
      '<td class="num">'+esc(model)+'</td>' +
      '<td class="right num">'+(r.attempts||'—')+'</td>' +
      '<td class="right num">'+money(r.costUsd)+'</td>' +
      '<td class="right num faint">'+dur(r.durationMs)+'</td>' +
      '<td class="right faint">'+when(r.endedAt)+'</td>' +
      '</tr>';
  }).join('');
  el('runspanel').innerHTML = head + rows + '</tbody></table>';
  var trs = el('runspanel').querySelectorAll('tbody tr');
  for(var i=0;i<trs.length;i++){
    trs[i].addEventListener('click', function(e){
      var cmpBtn = e.target.closest ? e.target.closest('.cmp-btn') : null;
      var cmpCell = e.target.closest ? e.target.closest('.cmp-col') : null;
      if(cmpBtn || cmpCell){
        var cmpid = (cmpBtn || cmpCell).getAttribute('data-cmpid');
        if(cmpid) { toggleDiffSelect(cmpid); return; }
      }
      openRun(this.getAttribute('data-id'));
    });
  }
  /* sync active highlight */
  var active_trs = el('runspanel').querySelectorAll('tbody tr');
  for(var ai=0;ai<active_trs.length;ai++){
    active_trs[ai].classList.toggle('active', active_trs[ai].getAttribute('data-id') === state.selected);
  }
}

/* ---- diff select ---- */
function toggleDiffSelect(id){
  var idx = state.diffIds.indexOf(id);
  if(idx !== -1){
    state.diffIds.splice(idx, 1);
  } else {
    if(state.diffIds.length >= 2) state.diffIds.shift();
    state.diffIds.push(id);
  }
  renderRunsTable();
  if(state.diffIds.length === 2){
    openDiff(state.diffIds[0], state.diffIds[1]);
  } else {
    el('diffpanel').style.display = 'none';
  }
}

function clearDiff(){
  state.diffIds = [];
  el('diffpanel').style.display = 'none';
  renderRunsTable();
}

function diffVal(a, b, fmt){
  var va = fmt ? fmt(a) : esc(String(a == null ? '—' : a));
  var vb = fmt ? fmt(b) : esc(String(b == null ? '—' : b));
  var changed = String(a) !== String(b);
  var cls = changed ? ' diff-changed' : '';
  return [
    '<span class="dv'+cls+'">'+va+'</span>',
    '<span class="dv'+cls+'">'+vb+'</span>'
  ];
}

function evTypeSequence(events){
  return events.map(function(ev){ return ev.type; });
}

function renderEvSequence(seqA, seqB){
  var len = Math.max(seqA.length, seqB.length);
  var rows = '';
  for(var i=0;i<len;i++){
    var ta = seqA[i] || '';
    var tb = seqB[i] || '';
    var match = ta === tb;
    var cls = match ? '' : ' diff-changed';
    rows += '<div class="seq-row"><span class="seq-ev'+cls+'">'+esc(ta||'—')+'</span><span class="seq-ev'+cls+'">'+esc(tb||'—')+'</span></div>';
  }
  return rows || '<div class="seq-row"><span class="seq-ev">—</span><span class="seq-ev">—</span></div>';
}

function openDiff(idA, idB){
  var dp = el('diffpanel');
  dp.style.display = 'block';
  dp.innerHTML = '<div class="diff-loading">Loading diff…</div>';
  Promise.all([
    api('/api/runs/' + encodeURIComponent(idA)),
    api('/api/runs/' + encodeURIComponent(idB))
  ]).then(function(res){
    var dA = res[0]; var dB = res[1];
    if(dA.error || dB.error){ dp.innerHTML = '<div class="empty">Could not load one or both runs.</div>'; return; }
    var sA = dA.summary; var sB = dB.summary;
    var rows = [];
    function row(label, va, vb){
      rows.push('<tr><td class="diff-label">'+label+'</td><td>'+va+'</td><td>'+vb+'</td></tr>');
    }
    var stA = diffVal(sA.status, sB.status); row('status', stA[0], stA[1]);
    var mA = diffVal(sA.finalModel||'—', sB.finalModel||'—'); row('model', mA[0], mA[1]);
    var atA = diffVal(sA.attempts, sB.attempts); row('attempts', atA[0], atA[1]);
    var evA = diffVal(dA.events.length, dB.events.length); row('events', evA[0], evA[1]);
    var cA = diffVal(sA.costUsd, sB.costUsd, function(v){ return esc(money(v)); }); row('cost', cA[0], cA[1]);
    var dmsA = diffVal(sA.durationMs, sB.durationMs, function(v){ return esc(dur(v)); }); row('duration', dmsA[0], dmsA[1]);
    var seqA = evTypeSequence(dA.events);
    var seqB = evTypeSequence(dB.events);
    var seqHtml = renderEvSequence(seqA, seqB);
    dp.innerHTML =
      '<div class="diff-head">' +
        '<div class="diff-title">Diff</div>' +
        '<div class="diff-ids">' +
          '<span class="chip">'+esc(idA)+'</span>' +
          '<span class="diff-vs">vs</span>' +
          '<span class="chip">'+esc(idB)+'</span>' +
        '</div>' +
        '<button class="diff-close" id="diffclose">Clear</button>' +
      '</div>' +
      '<div class="diff-body">' +
        '<div class="diff-cols">' +
          '<table class="diff-table">' +
            '<thead><tr><th></th><th class="num mut">'+esc(idA)+'</th><th class="num mut">'+esc(idB)+'</th></tr></thead>' +
            '<tbody>'+rows.join('')+'</tbody>' +
          '</table>' +
        '</div>' +
        '<div class="diff-seq-wrap">' +
          '<div class="label">Event sequence</div>' +
          '<div class="diff-seq-cols">' +
            '<div class="diff-seq-hdr"><span>'+esc(idA)+'</span><span>'+esc(idB)+'</span></div>' +
            '<div class="diff-seq" id="diffseq">'+seqHtml+'</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    el('diffclose').addEventListener('click', clearDiff);
  });
}

function modelTag(m){
  var provider = m.id.split('/')[0];
  if(provider === 'ollama') return 'local';
  if(m.cost && m.cost.inputPerMTok === 0 && m.cost.outputPerMTok === 0) return 'subscription';
  return 'metered';
}
function priceText(m, tag){
  if(tag === 'local') return 'local · free';
  if(tag === 'subscription') return 'subscription · $0';
  return '$' + m.cost.inputPerMTok + ' / $' + m.cost.outputPerMTok + ' per MTok';
}
function sourceText(m){
  if(m.notes && m.notes.indexOf('Seed estimate') !== -1) return 'seed estimate — override in config';
  var tag = modelTag(m);
  if(tag === 'local') return 'local model';
  if(tag === 'subscription') return 'subscription-backed';
  return 'pricing per provider docs';
}

function renderFleet(models){
  state.models = models;
  el('fleet').innerHTML = models.map(function(m){
    var tag = modelTag(m);
    var caps = CAPS.map(function(c){
      var v = (m.capabilities && m.capabilities[c[0]]) || 0;
      return '<div class="cap"><span class="cl">'+c[1]+'</span><span class="bar"><i style="width:'+Math.round(v*100)+'%"></i></span><span class="cv">'+v.toFixed(2)+'</span></div>';
    }).join('');
    var off = m.enabled === false ? ' off' : '';
    return '<div class="card'+off+'">' +
      '<div class="top"><span class="id">'+esc(m.id)+'</span><span class="tag '+tag+'">'+tag+'</span></div>' +
      '<div class="kv"><span class="k">'+esc(m.displayName || '')+'</span></div>' +
      '<div class="kv"><span class="k">price</span><span class="val">'+priceText(m, tag)+'</span></div>' +
      '<div class="kv"><span class="k">context</span><span class="val">'+(m.contextWindow/1000).toLocaleString()+'K · out '+(m.maxOutputTokens/1000)+'K</span></div>' +
      '<div class="kv"><span class="k">throughput</span><span class="val">'+m.latency.tokensPerSec+' tok/s</span></div>' +
      '<div class="caps">'+caps+'</div>' +
      '<div class="src">'+esc(sourceText(m))+'</div>' +
      '</div>';
  }).join('');
}

function renderAbout(){
  var principles = [
    ['1','Every token in its right place — route by specialization, quality, cost, and speed.'],
    ['2','Nothing ships unverified — plan → route → execute → verify, escalate on failure.'],
    ['3','Explainable, always — every decision carries its scoring and every elimination its reason.'],
    ['4','Memory that endures — source-grounded context across sessions via Midas.'],
    ['5','Total observability — everything is a typed event; this UI is a projection of that stream.']
  ];
  var mstones = [
    ['M0','foundation: autorouter + verified pipeline + memory port','done'],
    ['M1','real providers + apollo run + config + Midas transport','done'],
    ['M1.5','subscription login + workspace verification + self-correction','done'],
    ['M1.6','recorded + replayable runs + rate-limit backoff','done'],
    ['M2','local dashboard — this','done']
  ];
  el('about').innerHTML =
    '<p>Apollo is the execution layer of Archic: a local-first AI harness that routes every task to the right model — across every provider, subscription, and API you configure — and runs it through a pipeline that verifies before it ships.</p>' +
    '<p>The strongest reasoning model plans; the strongest coding model acts; nothing is reported done unless verification passed; every decision is explainable.</p>' +
    '<h2 class="label">Principles</h2>' +
    principles.map(function(p){ return '<div class="principle"><span class="n">'+p[0]+'</span><span>'+esc(p[1])+'</span></div>'; }).join('') +
    '<h2 class="label">Milestones</h2><div class="mstones">' +
    mstones.map(function(m){ return '<div class="mstone"><span class="m">'+m[0]+'</span><span>'+esc(m[1])+'</span><span class="s">'+(m[2]==='done'?'✓':'')+'</span></div>'; }).join('') +
    '</div>';
}

/* ---- run detail ---- */
function evMeta(ev){
  var t = ev.type;
  if(t === 'task.started') return { cls:'gold', k:'task.started', d: esc(ev.title) };
  if(t === 'task.planned') return { cls:'', k:'task.planned', d: esc(ev.summary) };
  if(t === 'routing.decided') return { cls:'blue', k:'routing.decided', model: ev.modelId, reason: ev.reason };
  if(t === 'execution.started') return { cls:'', k:'execution.started', d:'attempt ' + ev.attempt };
  if(t === 'execution.completed') return { cls:'', k:'execution.completed', d:'attempt ' + ev.attempt + (ev.modelId ? ' · ' + ev.modelId : '') + (ev.costUsd != null ? ' · ' + money(ev.costUsd) : '') };
  if(t === 'execution.failed') return { cls:'red', k:'execution.failed', d:'attempt ' + ev.attempt + ': ' + esc(ev.error) };
  if(t === 'verification.passed') return { cls:'green', k:'verification.passed', d:'attempt ' + ev.attempt };
  if(t === 'verification.failed') return { cls:'red', k:'verification.failed', d:'attempt ' + ev.attempt + ': ' + esc((ev.issues||[]).join('; ')) };
  if(t === 'task.completed') return { cls:'green', k:'task.completed', d:'in ' + ev.attempts + ' attempt(s)' };
  if(t === 'task.failed') return { cls:'red', k:'task.failed', d: esc(ev.reason) };
  if(t === 'plan.produced') return { cls:'gold', k:'plan.produced', d: ev.steps + ' step(s) · confidence ' + Number(ev.confidence).toFixed(2) + (ev.replan ? ' (replan)' : '') };
  if(t === 'step.started') return { cls:'blue', k:'step.started ' + ev.stepId, d: esc(ev.description) };
  if(t === 'step.finished') return { cls: ev.status === 'done' ? 'green' : 'red', k:'step.finished ' + ev.stepId, d: ev.status + (ev.note ? ' — ' + esc(ev.note) : '') };
  if(t === 'belief.recorded') return { cls:'', k:'belief', d: esc(ev.key) + ' = ' + esc(ev.value) };
  if(t === 'critic.reviewed') return { cls: ev.verdict === 'pass' ? 'green' : 'red', k:'critic ' + ev.stepId, d: ev.verdict + (ev.forceReplan ? ' (force replan)' : '') + (ev.note ? ' — ' + esc(ev.note) : '') };
  if(t === 'permission.decided') return { cls: ev.decision === 'allow' ? 'green' : 'red', k:'permission.' + ev.decision, d:esc(ev.tool) + ' · ' + esc(ev.risk) + ' — ' + esc(ev.reason) };
  if(t === 'meta.stop') return { cls:'red', k:'meta.stop', d: ev.status + ': ' + esc(ev.reason) };
  return { cls:'', k: t, d:'' };
}
function evNode(ev, t0){
  var m = evMeta(ev);
  var at = t0 ? '<span class="at">+' + ((ev.at - t0)/1000).toFixed(2) + 's</span>' : '';
  var body = '<div class="t"><span class="k">' + m.k + '</span>' + at + '</div>';
  if(m.model) body += '<div class="d"><span class="model">' + esc(m.model) + '</span></div>';
  if(m.reason) body += '<div class="reason">' + esc(m.reason) + '</div>';
  else if(m.d) body += '<div class="d">' + m.d + '</div>';
  return '<div class="ev ' + m.cls + '"><span class="node"></span>' + body + '</div>';
}

function missionEvidence(bundle){
  if(!bundle || !bundle.outcome || !bundle.evidence) return '';
  var outcome = bundle.outcome;
  var items = bundle.evidence.items || [];
  var rows = items.map(function(item){
    return '<div class="ev '+(item.status==='passed'?'ok':item.status==='failed'?'bad':'')+'"><span class="node"></span><div class="t"><span class="k">'+esc(item.kind)+' · '+esc(item.status)+'</span></div><div class="d">'+esc(item.summary)+'</div></div>';
  }).join('');
  var risks = (outcome.remainingRisks || []).map(function(r){ return '<span class="chip red">'+esc(r)+'</span>'; }).join('');
  return '<div class="evidence-head"><div class="label">Mission evidence · schema v'+esc(bundle.evidence.schemaVersion)+'</div><div class="dmeta">'+risks+'</div></div>'+rows;
}

function openRun(id){
  state.selected = id;
  /* update highlight */
  var trs = document.querySelectorAll('#runspanel tbody tr');
  for(var i=0;i<trs.length;i++){ trs[i].classList.toggle('active', trs[i].getAttribute('data-id') === id); }
  api('/api/runs/' + encodeURIComponent(id)).then(function(data){
    if(data.error){ return; }
    state.selectedEvents = data.events;
    var s = data.summary;
    el('dtitle').textContent = s.title;
    var chips = [];
    chips.push('<span class="chip ' + (s.status==='succeeded'?'green':s.status==='failed'?'red':'') + '">' + s.status + '</span>');
    if(s.finalModel) chips.push('<span class="chip gold">' + esc(s.finalModel) + '</span>');
    chips.push('<span class="chip">' + (s.attempts||1) + ' attempt(s)</span>');
    chips.push('<span class="chip">' + money(s.costUsd) + '</span>');
    chips.push('<span class="chip">' + dur(s.durationMs) + '</span>');
    if(s.models && s.models.length > 1) chips.push('<span class="chip">path: ' + esc(s.models.join(' -> ')) + '</span>');
    el('dmeta').innerHTML = chips.join('');
    var t0 = data.events.length ? data.events[0].at : 0;
    el('timeline').innerHTML = missionEvidence(data.mission) + data.events.map(function(ev){ return evNode(ev, t0); }).join('');
    el('drawer').classList.add('open');
  });
}
function closeDrawer(){ el('drawer').classList.remove('open'); state.selected = null; }

/* ---- live stream ---- */
function setLive(on){
  var live = el('live');
  live.classList.toggle('on', on);
  el('livetext').textContent = on ? 'streaming' : 'idle';
  var sun = document.querySelector('.sun');
  if(sun) sun.style.opacity = on ? '1' : '0.85';
  if(liveTimer) clearTimeout(liveTimer);
  if(on) liveTimer = setTimeout(function(){ setLive(false); }, 4000);
}
var reloadPending = false;
function reloadSoon(){
  if(reloadPending) return;
  reloadPending = true;
  setTimeout(function(){
    reloadPending = false;
    api('/api/runs').then(function(data){ renderRuns(data && data.runs ? data.runs : data); });
    api('/api/stats').then(renderStats);
    if(state.selected) refreshDetail(state.selected);
  }, 400);
}
function refreshDetail(id){
  api('/api/runs/' + encodeURIComponent(id)).then(function(data){
    if(data.error) return;
    var t0 = data.events.length ? data.events[0].at : 0;
    el('timeline').innerHTML = data.events.map(function(ev){ return evNode(ev, t0); }).join('');
  });
}
function connectStream(){
  if(typeof EventSource === 'undefined') return;
  var es = new EventSource('/api/stream');
  es.addEventListener('run-event', function(e){
    setLive(true);
    var payload = JSON.parse(e.data);
    if(state.selected && payload.runId === state.selected){
      var t0 = state.selectedEvents && state.selectedEvents.length ? state.selectedEvents[0].at : payload.event.at;
      if(state.selectedEvents) state.selectedEvents.push(payload.event);
      var node = document.createElement('div');
      node.innerHTML = evNode(payload.event, t0);
      var child = node.firstChild;
      child.classList.add('newflash');
      el('timeline').appendChild(child);
    }
  });
  es.addEventListener('runs-changed', function(){ reloadSoon(); });
  es.onerror = function(){ /* browser auto-reconnects */ };
}

/* ---- boot ---- */
function boot(){
  var nav = el('nav');
  nav.addEventListener('click', function(e){
    var item = e.target.closest ? e.target.closest('.navitem') : null;
    if(item) switchView(item.getAttribute('data-view'));
  });
  el('dclose').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeDrawer(); });
  el('runsearch').addEventListener('input', function(){
    state.searchQ = this.value;
    renderRunsTable();
  });
  el('mission-form').addEventListener('submit', submitMission);
  el('mission-list').addEventListener('click', missionAction);
  renderAbout();
  Promise.all([ api('/api/stats'), api('/api/runs'), api('/api/models'), api('/api/health'), api('/api/control') ]).then(function(res){
    renderStats(res[0]);
    var runs = res[1] && res[1].runs ? res[1].runs : res[1];
    renderRuns(runs);
    renderFleet(res[2].models);
    renderHealth(res[3]);
    state.missions = res[4].missions || [];
    renderMissions(res[4]);
    var cnt = Array.isArray(runs) ? runs.length : 0;
    el('vsub').textContent = cnt + ' recorded runs';
  });
  connectStream();
  setInterval(loadMissionControl, 1500);
}
boot();
`;

const DOCUMENT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Apollo</title>
<style>
:root {
  --bg: #0a0b0d;
  --panel: #101216;
  --elev: #15181e;
  --border: rgba(255,255,255,0.07);
  --border-strong: rgba(255,255,255,0.13);
  --text: #e7e8ea;
  --dim: #9aa0a8;
  --faint: #5f656e;
  --gold: #f2b336;
  --gold-soft: rgba(242,179,54,0.13);
  --green: #4bbb85;
  --red: #e5544b;
  --blue: #6aa6df;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  display: grid;
  grid-template-columns: 236px 1fr;
  height: 100vh;
  overflow: hidden;
}
.mono { font-family: var(--mono); }
.label { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }

/* ---- sidebar ---- */
aside {
  border-right: 1px solid var(--border);
  padding: 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: linear-gradient(180deg, rgba(255,255,255,0.015), transparent 40%);
}
.brand { display: flex; align-items: center; gap: 11px; margin-bottom: 26px; }
.sun { width: 26px; height: 26px; flex: none; }
.sun .core { fill: var(--gold); }
.sun .ray { stroke: var(--gold); stroke-width: 1.6; stroke-linecap: round; }
.wordmark { font-family: var(--mono); font-weight: 600; letter-spacing: 0.22em; font-size: 15px; }
.tagline { font-size: 11px; color: var(--faint); margin-top: 1px; letter-spacing: 0.02em; }
nav { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.navitem {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 11px; border-radius: 7px; cursor: pointer;
  color: var(--dim); font-size: 13px; user-select: none;
  border: 1px solid transparent;
}
.navitem:hover { background: var(--elev); color: var(--text); }
.navitem.active { background: var(--gold-soft); color: var(--gold); border-color: rgba(242,179,54,0.2); }
.navitem .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.6; }
.spacer { flex: 1; }
.foot { border-top: 1px solid var(--border); padding-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.live { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--faint); }
.live .pip { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); transition: background 0.3s; }
.live.on .pip { background: var(--green); box-shadow: 0 0 8px var(--green); }
.archic { font-size: 11px; color: var(--faint); letter-spacing: 0.03em; }
.archic b { color: var(--dim); font-weight: 600; }

/* ---- main ---- */
main { overflow-y: auto; padding: 26px 30px 60px; }
.topbar { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22px; }
.topbar h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
.topbar .sub { color: var(--faint); font-size: 12.5px; }
.view { display: none; }
.view.active { display: block; animation: fade 0.25s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

/* ---- stat strip ---- */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 11px; padding: 15px 16px; }
.stat .v { font-family: var(--mono); font-size: 24px; font-weight: 500; margin-top: 7px; letter-spacing: -0.01em; }
.stat .v.gold { color: var(--gold); }
.stat .v.green { color: var(--green); }
.stat .sub2 { font-size: 11px; color: var(--faint); margin-top: 3px; }

/* ---- table ---- */
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 11px; overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); font-weight: 500; padding: 11px 14px; border-bottom: 1px solid var(--border); }
td { padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--elev); }
tbody tr.active { background: var(--gold-soft); }
.sdot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.sdot.succeeded { background: var(--green); }
.sdot.failed { background: var(--red); }
.sdot.incomplete { background: var(--gold); }
.mut { color: var(--dim); }
.faint { color: var(--faint); }
.num { font-family: var(--mono); font-size: 12.5px; }
.right { text-align: right; }
.empty { padding: 44px; text-align: center; color: var(--faint); }

/* ---- mission center ---- */
.mission-grid { display:grid; grid-template-columns:minmax(320px, 0.9fr) minmax(420px, 1.4fr); gap:14px; }
.mission-form { padding:18px; display:flex; flex-direction:column; gap:12px; }
.mission-form label { color:var(--dim); font-size:12px; display:flex; flex-direction:column; gap:6px; }
.mission-form textarea,.mission-form input[type="text"] { width:100%; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); padding:10px 11px; font:12.5px var(--mono); outline:none; }
.mission-form textarea { min-height:132px; resize:vertical; font-family:var(--sans); font-size:14px; }
.mission-form textarea:focus,.mission-form input:focus { border-color:rgba(242,179,54,.5); }
.mission-checks { display:flex; gap:16px; flex-wrap:wrap; }
.mission-checks label { flex-direction:row; align-items:center; gap:7px; }
button { background:var(--elev); color:var(--text); border:1px solid var(--border-strong); border-radius:7px; padding:7px 12px; cursor:pointer; }
button:hover { border-color:var(--gold); }
.gold-btn,#mission-submit { background:var(--gold); color:#171108; border-color:var(--gold); font-weight:650; }
button.danger { color:var(--red); }
.mission-error { min-height:18px; color:var(--red); font-size:12px; }
.mission-list { max-height:620px; overflow:auto; }
.mission-row { display:flex; gap:12px; align-items:flex-start; padding:14px 15px; border-bottom:1px solid var(--border); }
.mission-row .sdot { margin-top:6px; flex:none; }
.mission-main { flex:1; min-width:0; }
.mission-goal { line-height:1.4; }
.mission-answer { margin-top:8px; padding:9px 10px; border-left:2px solid var(--gold); background:var(--gold-soft); color:var(--text); line-height:1.45; white-space:pre-wrap; }
.mission-meta { color:var(--faint); font-size:10.5px; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mission-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.health { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.health span { font:10.5px var(--mono); color:var(--faint); background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:5px 8px; }
.health .health-ok { color:var(--green); }
.notice { padding:12px 14px; color:var(--gold); margin-bottom:12px; }

/* ---- run detail drawer ---- */
.drawer { position: fixed; top: 0; right: 0; width: min(560px, 52vw); height: 100vh; background: var(--panel); border-left: 1px solid var(--border-strong); box-shadow: -20px 0 50px rgba(0,0,0,0.4); transform: translateX(100%); transition: transform 0.28s cubic-bezier(0.4,0,0.2,1); z-index: 20; display: flex; flex-direction: column; }
.drawer.open { transform: none; }
.drawer .dhead { padding: 20px 22px; border-bottom: 1px solid var(--border); }
.drawer .dhead .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.drawer .dtitle { font-size: 15px; font-weight: 600; }
.drawer .close { cursor: pointer; color: var(--faint); font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.drawer .close:hover { background: var(--elev); color: var(--text); }
.dmeta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.chip { font-family: var(--mono); font-size: 11px; padding: 3px 9px; border-radius: 6px; background: var(--elev); border: 1px solid var(--border); color: var(--dim); }
.chip.gold { color: var(--gold); border-color: rgba(242,179,54,0.25); background: var(--gold-soft); }
.chip.green { color: var(--green); border-color: rgba(75,187,133,0.25); }
.chip.red { color: var(--red); border-color: rgba(229,84,75,0.25); }
.tlwrap { overflow-y: auto; padding: 18px 22px 30px; }

/* ---- timeline ---- */
.tl { position: relative; padding-left: 22px; }
.tl::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 1px; background: var(--border-strong); }
.ev { position: relative; padding: 7px 0; }
.ev .node { position: absolute; left: -22px; top: 12px; width: 11px; height: 11px; border-radius: 50%; background: var(--faint); border: 2px solid var(--bg); }
.ev.gold .node { background: var(--gold); }
.ev.green .node { background: var(--green); }
.ev.red .node { background: var(--red); }
.ev.blue .node { background: var(--blue); }
.ev .t { font-family: var(--mono); font-size: 12px; }
.ev .t .k { color: var(--dim); }
.ev.gold .t .k, .ev.green .t .k, .ev.red .t .k { color: var(--text); font-weight: 600; }
.ev .t .at { color: var(--faint); font-size: 10.5px; margin-left: 8px; }
.ev .d { font-size: 12px; color: var(--dim); margin-top: 3px; }
.ev .reason { font-size: 11.5px; color: var(--faint); margin-top: 3px; line-height: 1.5; border-left: 1px solid var(--border-strong); padding-left: 9px; }
.ev .model { color: var(--blue); }
.newflash { animation: flash 1s ease; }
@keyframes flash { from { background: var(--gold-soft); } to { background: transparent; } }

/* ---- fleet ---- */
.fleet { display: grid; grid-template-columns: repeat(auto-fill, minmax(288px, 1fr)); gap: 13px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 11px; padding: 15px 16px; }
.card.off { opacity: 0.5; }
.card .id { font-family: var(--mono); font-size: 13px; font-weight: 500; }
.card .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.tag { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 7px; border-radius: 5px; white-space: nowrap; }
.tag.subscription { color: var(--gold); background: var(--gold-soft); }
.tag.local { color: var(--green); background: rgba(75,187,133,0.12); }
.tag.metered { color: var(--dim); background: var(--elev); }
.card .kv { display: flex; justify-content: space-between; font-size: 12px; margin-top: 5px; }
.card .kv .k { color: var(--faint); }
.card .kv .val { font-family: var(--mono); font-size: 12px; }
.caps { margin-top: 13px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; }
.cap { display: flex; align-items: center; gap: 7px; }
.cap .cl { font-family: var(--mono); font-size: 9.5px; color: var(--faint); width: 30px; text-transform: uppercase; }
.cap .bar { flex: 1; height: 4px; background: var(--elev); border-radius: 2px; overflow: hidden; }
.cap .bar i { display: block; height: 100%; background: var(--gold); border-radius: 2px; }
.cap .cv { font-family: var(--mono); font-size: 10px; color: var(--dim); width: 22px; text-align: right; }
.src { margin-top: 12px; font-size: 10.5px; color: var(--faint); }

/* ---- about ---- */
.about { max-width: 720px; }
.about p { color: var(--dim); margin-bottom: 14px; }
.about h2 { font-size: 14px; margin: 22px 0 10px; letter-spacing: 0.01em; }
.about .principle { display: flex; gap: 11px; padding: 9px 0; border-bottom: 1px solid var(--border); }
.about .principle .n { font-family: var(--mono); color: var(--gold); font-size: 12px; }
.mstones { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.mstone { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
.mstone .m { font-family: var(--mono); font-size: 11px; color: var(--gold); width: 44px; }
.mstone .s { color: var(--green); }

/* ---- search bar ---- */
.search-bar { margin-bottom: 10px; }
.search-bar input {
  width: 100%; max-width: 360px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 13px;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  outline: none;
  transition: border-color 0.15s;
}
.search-bar input::placeholder { color: var(--faint); }
.search-bar input:focus { border-color: var(--border-strong); }

/* ---- compare button ---- */
.cmp-col { width: 28px; padding-left: 10px !important; padding-right: 4px !important; }
.cmp-btn {
  display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
  font-size: 14px; color: var(--faint); cursor: pointer; border-radius: 4px;
  user-select: none; transition: color 0.12s;
}
.cmp-btn:hover { color: var(--gold); }
.cmp-btn.cmp-on { color: var(--gold); }

/* ---- diff panel ---- */
.diff-panel {
  margin-top: 14px;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  overflow: hidden;
  animation: fade 0.22s ease;
}
.diff-head {
  display: flex; align-items: center; gap: 12px;
  padding: 13px 18px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.diff-title {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--faint); flex: none;
}
.diff-ids { display: flex; align-items: center; gap: 8px; flex: 1; flex-wrap: wrap; }
.diff-vs { color: var(--faint); font-size: 11px; font-family: var(--mono); }
.diff-close {
  background: transparent; border: 1px solid var(--border);
  color: var(--dim); font-family: var(--mono); font-size: 11px;
  padding: 4px 11px; border-radius: 6px; cursor: pointer;
}
.diff-close:hover { border-color: var(--border-strong); color: var(--text); }
.diff-body { display: grid; grid-template-columns: auto 1fr; gap: 0; }
.diff-cols { padding: 14px 18px; border-right: 1px solid var(--border); }
.diff-table { border-collapse: collapse; font-size: 12.5px; }
.diff-table th { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); padding: 5px 14px 5px 0; font-weight: 500; }
.diff-table td { padding: 5px 18px 5px 0; vertical-align: top; }
.diff-label { font-family: var(--mono); font-size: 11px; color: var(--faint); padding-right: 22px !important; white-space: nowrap; }
.dv { font-family: var(--mono); font-size: 12.5px; color: var(--dim); }
.dv.diff-changed { color: var(--gold); font-weight: 600; }
.diff-seq-wrap { padding: 14px 18px; overflow-x: auto; }
.diff-seq-hdr { display: flex; gap: 0; margin-bottom: 6px; }
.diff-seq-hdr span { flex: 1; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
.diff-seq { max-height: 260px; overflow-y: auto; }
.seq-row { display: flex; }
.seq-ev { flex: 1; font-family: var(--mono); font-size: 11px; color: var(--dim); padding: 2px 8px 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seq-ev.diff-changed { color: var(--gold); }
.diff-loading { padding: 20px; color: var(--faint); font-family: var(--mono); font-size: 12px; }
</style>
</head>
<body>
<aside>
  <div class="brand">
    <svg class="sun" viewBox="0 0 24 24" fill="none">
      <circle class="core" cx="12" cy="12" r="4.2" />
      <g class="ray">
        <line x1="12" y1="1.5" x2="12" y2="4.2" /><line x1="12" y1="19.8" x2="12" y2="22.5" />
        <line x1="1.5" y1="12" x2="4.2" y2="12" /><line x1="19.8" y1="12" x2="22.5" y2="12" />
        <line x1="4.4" y1="4.4" x2="6.3" y2="6.3" /><line x1="17.7" y1="17.7" x2="19.6" y2="19.6" />
        <line x1="19.6" y1="4.4" x2="17.7" y2="6.3" /><line x1="6.3" y1="17.7" x2="4.4" y2="19.6" />
      </g>
    </svg>
    <div>
      <div class="wordmark">APOLLO</div>
      <div class="tagline">Archic harness</div>
    </div>
  </div>
  <nav id="nav">
    <div class="navitem" data-view="missions"><span class="dot"></span> Missions</div>
    <div class="navitem active" data-view="runs"><span class="dot"></span> Runs</div>
    <div class="navitem" data-view="fleet"><span class="dot"></span> Fleet</div>
    <div class="navitem" data-view="about"><span class="dot"></span> About</div>
  </nav>
  <div class="spacer"></div>
  <div class="foot">
    <div class="live" id="live"><span class="pip"></span> <span id="livetext">idle</span></div>
    <div class="archic">Part of <b>Archic</b> · local-first</div>
  </div>
</aside>

<main>
  <div class="topbar">
    <h1 id="vtitle">Runs</h1>
    <div class="sub" id="vsub"></div>
  </div>

  <section class="view active" id="view-runs">
    <div class="stats" id="stats"></div>
    <div class="search-bar">
      <input id="runsearch" type="search" placeholder="Search runs…" autocomplete="off" spellcheck="false" />
    </div>
    <div class="panel" id="runspanel"></div>
    <div id="diffpanel" class="diff-panel" style="display:none"></div>
  </section>

  <section class="view" id="view-missions">
    <div class="health" id="health"></div>
    <div class="panel notice" id="mission-disabled" style="display:none">Mission control is read-only in this runtime.</div>
    <div class="mission-grid">
      <form class="panel mission-form" id="mission-form">
        <div class="label">New verified mission</div>
        <label>Goal<textarea id="mission-goal" required maxlength="20000" placeholder="Fix the failing tests and prove they pass"></textarea></label>
        <label>Workspace<input id="mission-workspace" type="text" required value="." placeholder="/path/to/project" /></label>
        <label>Deterministic checks<input id="mission-check" type="text" placeholder="command_succeeds:npm test" /></label>
        <div class="mission-checks">
          <label><input id="mission-approve" type="checkbox" /> Approve policy prompts</label>
          <label><input id="mission-memory" type="checkbox" checked /> Use Midas context</label>
        </div>
        <button id="mission-submit" type="submit">Start mission</button>
        <div class="mission-error" id="mission-error"></div>
      </form>
      <div class="panel mission-list" id="mission-list"></div>
    </div>
  </section>

  <section class="view" id="view-fleet">
    <div class="fleet" id="fleet"></div>
  </section>

  <section class="view" id="view-about">
    <div class="about" id="about"></div>
  </section>
</main>

<div class="drawer" id="drawer">
  <div class="dhead">
    <div class="row"><div class="dtitle" id="dtitle">Run</div><div class="close" id="dclose">&times;</div></div>
    <div class="dmeta" id="dmeta"></div>
  </div>
  <div class="tlwrap"><div class="tl" id="timeline"></div></div>
</div>

<script>
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
