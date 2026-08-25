export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#07111f" />
  <title>医博生物 · 混剪进度看板</title>
  <link rel="stylesheet" href="/dashboard/styles.css" />
</head>
<body>
  <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">医</span><div><strong>混剪进度看板</strong><small>医博生物 · 云管家全流程监控</small></div></div>
      <div class="top-actions"><span id="connection" class="connection">正在连接</span><button id="refreshButton" class="ghost">刷新</button><button id="logoutButton" class="ghost">退出</button></div>
    </header>

    <section class="hero">
      <div><span class="eyebrow">LIVE WORKFLOW</span><h1>每一条成片，<br />从素材到云端都看得见。</h1><p id="lastUpdated">等待任务数据</p></div>
      <div class="pipeline" aria-label="处理流程">
        <span>素材传输</span><i></i><span>混剪</span><i></i><span>下载</span><i></i><span>上传云管家</span><i></i><span>云端处理</span>
      </div>
    </section>

    <section class="stats" aria-label="任务统计">
      <article><span>进行中</span><strong id="statActive">0</strong><small>正在处理的任务</small></article>
      <article><span>今日上传成功</span><strong id="statSuccess">0</strong><small>云管家已确认成功</small></article>
      <article><span>等待队列</span><strong id="statQueued">0</strong><small>等待服务器资源</small></article>
      <article class="danger"><span>需要关注</span><strong id="statAttention">0</strong><small>失败、超时或中断</small></article>
    </section>

    <section class="content-card">
      <div class="section-head"><div><span class="eyebrow">TASK CENTER</span><h2>任务中心</h2></div><div class="filters" id="filters"><button class="active" data-filter="all">全部</button><button data-filter="active">进行中</button><button data-filter="success">上传成功</button><button data-filter="problem">需关注</button></div></div>
      <div id="activeSection"><h3>正在进行</h3><div id="activeList" class="task-grid"></div></div>
      <div class="history-head"><h3>历史任务</h3><span id="historyCount">0 条记录</span></div>
      <div id="historyList" class="history-list"></div>
      <div id="emptyState" class="empty hidden"><strong>还没有任务记录</strong><span>从混剪工具启动任务后，进度会自动出现在这里。</span></div>
    </section>
  </main>

  <div id="loginModal" class="modal-backdrop">
    <section class="login-card" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
      <span class="brand-mark large">医</span><span class="eyebrow">SECURE ACCESS</span><h2 id="loginTitle">连接混剪服务器</h2><p>输入服务器启动时显示的访问 Token，查看公司内网任务。</p>
      <label><span>服务器 Token</span><input id="tokenInput" type="password" autocomplete="current-password" placeholder="输入访问 Token" /></label>
      <label class="remember"><input id="rememberInput" type="checkbox" /><span>记住本设备</span></label>
      <p id="loginError" class="error-text"></p><button id="loginButton" class="primary">进入看板</button>
    </section>
  </div>

  <div id="detailModal" class="modal-backdrop hidden">
    <section class="detail-card" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
      <button id="closeDetail" class="close" aria-label="关闭">×</button><div id="detailContent"></div>
    </section>
  </div>
  <script src="/dashboard/app.js" defer></script>
</body>
</html>`;

export const DASHBOARD_CSS = `
:root{color-scheme:dark;--bg:#06101d;--panel:rgba(13,27,43,.84);--line:rgba(163,200,219,.14);--muted:#8fa6b7;--text:#f1f8fb;--cyan:#4fe3d2;--blue:#6ea8ff;--orange:#ffb45b;--red:#ff6c7a;--green:#6ff0ad;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif}
.task-owner{display:flex;align-items:center;gap:8px;margin:14px 0;color:var(--cyan);font-size:12px}.task-owner:before{content:"上传人";padding:3px 7px;border-radius:20px;background:rgba(79,227,210,.1);color:#aeece6;font-size:10px}.history-name strong,.history-name small{display:block}.history-name small{margin-top:5px;color:var(--cyan);font-size:11px}.detail-summary{grid-template-columns:repeat(5,1fr)!important}.cloud-success{color:var(--green)!important}.cloud-pending{color:var(--cyan)!important}.cloud-warning{color:var(--orange)!important}.cloud-failed{color:var(--red)!important}
@media(max-width:560px){.detail-summary{grid-template-columns:1fr!important}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% -10%,#143654 0,transparent 38%),linear-gradient(160deg,#07121f 0%,#050b13 100%);color:var(--text);overflow-x:hidden}.ambient{position:fixed;border-radius:50%;filter:blur(80px);opacity:.16;pointer-events:none}.ambient-one{width:440px;height:440px;background:#2fd9cf;right:-180px;top:18%}.ambient-two{width:380px;height:380px;background:#315dff;left:-190px;bottom:4%}.shell{width:min(1500px,calc(100% - 48px));margin:auto;padding:24px 0 64px;position:relative}.topbar{display:flex;justify-content:space-between;align-items:center;padding:10px 0 28px}.brand{display:flex;gap:12px;align-items:center}.brand-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,var(--cyan),#43a2ff);color:#04121b;font-weight:900;box-shadow:0 8px 28px rgba(79,227,210,.22)}.brand-mark.large{width:58px;height:58px;font-size:22px;margin-bottom:20px}.brand strong,.brand small{display:block}.brand strong{font-size:16px}.brand small{color:var(--muted);font-size:12px;margin-top:3px}.top-actions{display:flex;gap:10px;align-items:center}.ghost,.filters button{border:1px solid var(--line);background:rgba(255,255,255,.035);color:#c9d8e1;border-radius:10px;padding:9px 14px;cursor:pointer}.ghost:hover,.filters button:hover,.filters button.active{background:rgba(79,227,210,.1);border-color:rgba(79,227,210,.38);color:#fff}.connection{font-size:12px;color:var(--orange);margin-right:8px}.connection.online{color:var(--green)}.hero{min-height:260px;display:flex;justify-content:space-between;align-items:center;gap:40px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:42px 0}.eyebrow{font-size:11px;letter-spacing:.24em;color:var(--cyan);font-weight:800}.hero h1{font-size:clamp(34px,5vw,68px);line-height:1.06;letter-spacing:-.04em;margin:14px 0 18px}.hero p{color:var(--muted);margin:0}.pipeline{width:min(580px,48vw);display:grid;grid-template-columns:repeat(9,auto);align-items:center;gap:8px;padding:24px;border-radius:18px;background:linear-gradient(135deg,rgba(24,47,69,.84),rgba(10,24,38,.85));border:1px solid var(--line);box-shadow:0 24px 70px rgba(0,0,0,.22)}.pipeline span{font-size:11px;text-align:center;white-space:nowrap}.pipeline i{height:1px;width:22px;background:linear-gradient(90deg,var(--blue),var(--cyan));opacity:.65}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}.stats article{padding:22px;border-radius:16px;background:var(--panel);border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.14)}.stats span,.stats small{display:block;color:var(--muted);font-size:12px}.stats strong{display:block;font-size:34px;margin:9px 0 5px}.stats .danger strong{color:var(--red)}.content-card{padding:28px;border:1px solid var(--line);border-radius:20px;background:rgba(8,20,33,.82);backdrop-filter:blur(18px)}.section-head,.history-head{display:flex;justify-content:space-between;align-items:center;gap:20px}.section-head h2{margin:7px 0 0;font-size:27px}.filters{display:flex;gap:8px}.filters button{padding:8px 13px}.content-card h3{font-size:13px;color:#a8bdca;font-weight:700;margin:28px 0 14px}.task-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.task-card{position:relative;padding:21px;border-radius:16px;background:linear-gradient(145deg,rgba(22,45,65,.88),rgba(10,25,39,.9));border:1px solid rgba(111,240,173,.2);cursor:pointer;transition:.2s}.task-card:hover,.history-row:hover{transform:translateY(-2px);border-color:rgba(79,227,210,.4)}.task-top,.task-meta,.progress-caption{display:flex;justify-content:space-between;gap:16px;align-items:center}.task-top strong{font-size:17px}.badge{font-size:11px;padding:5px 8px;border-radius:20px;background:rgba(79,227,210,.12);color:var(--cyan)}.badge.problem{color:var(--red);background:rgba(255,108,122,.11)}.task-message{font-size:13px;color:#b7c8d2;margin:18px 0 12px;min-height:20px}.progress-track{height:7px;border-radius:20px;background:rgba(255,255,255,.07);overflow:hidden}.progress-track div{height:100%;border-radius:inherit;background:linear-gradient(90deg,#5f8fff,var(--cyan));box-shadow:0 0 16px rgba(79,227,210,.35)}.progress-caption{font-size:11px;color:var(--muted);margin-top:8px}.task-meta{margin-top:18px;color:var(--muted);font-size:11px}.history-head{border-top:1px solid var(--line);margin-top:28px}.history-head span{color:var(--muted);font-size:12px}.history-list{display:grid;gap:8px}.history-row{display:grid;grid-template-columns:minmax(180px,1.4fr) 130px 1fr 100px 150px;gap:16px;align-items:center;padding:15px 17px;border:1px solid transparent;border-bottom-color:var(--line);cursor:pointer;transition:.2s}.history-row strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.history-row span{font-size:12px;color:var(--muted)}.result-success{color:var(--green)!important}.result-problem{color:var(--red)!important}.empty{text-align:center;padding:58px 20px;color:var(--muted)}.empty strong,.empty span{display:block}.empty strong{color:#dce9ef;font-size:18px;margin-bottom:8px}.hidden{display:none!important}.modal-backdrop{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px;background:rgba(1,6,11,.76);backdrop-filter:blur(12px)}.login-card,.detail-card{width:min(440px,100%);padding:34px;border-radius:22px;background:#0c1b2a;border:1px solid rgba(110,168,255,.22);box-shadow:0 28px 90px rgba(0,0,0,.5)}.login-card h2{font-size:29px;margin:10px 0}.login-card p{color:var(--muted);line-height:1.6}.login-card label>span{display:block;font-size:12px;color:#adc0cc;margin:22px 0 8px}.login-card input[type=password]{width:100%;padding:14px;border-radius:10px;border:1px solid var(--line);background:#07131f;color:#fff;outline:none}.login-card input:focus{border-color:var(--cyan)}.login-card .remember{display:flex;align-items:center;gap:8px;margin:14px 0}.login-card .remember span{margin:0}.primary{width:100%;padding:14px;border:0;border-radius:11px;background:linear-gradient(90deg,var(--cyan),#63a9ff);color:#04131c;font-weight:900;cursor:pointer}.error-text{min-height:20px;color:var(--red)!important;font-size:12px}.detail-card{position:relative;width:min(860px,100%);max-height:88vh;overflow:auto}.close{position:absolute;right:18px;top:15px;border:0;background:transparent;color:#98afbd;font-size:30px;cursor:pointer}.detail-head h2{font-size:26px;margin:8px 45px 8px 0}.detail-head p{color:var(--muted)}.detail-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0}.detail-summary div{padding:15px;background:rgba(255,255,255,.035);border-radius:12px}.detail-summary span,.detail-summary strong{display:block}.detail-summary span{font-size:11px;color:var(--muted)}.detail-summary strong{margin-top:7px}.timeline{border-left:1px solid rgba(79,227,210,.28);margin:20px 0 20px 8px}.timeline-item{position:relative;padding:0 0 19px 20px}.timeline-item:before{content:"";position:absolute;width:9px;height:9px;left:-5px;top:4px;border-radius:50%;background:var(--cyan);box-shadow:0 0 12px var(--cyan)}.timeline-item strong,.timeline-item span{display:block}.timeline-item strong{font-size:13px}.timeline-item span{font-size:11px;color:var(--muted);margin-top:4px}.video-table{width:100%;border-collapse:collapse}.video-table th,.video-table td{text-align:left;padding:11px;border-bottom:1px solid var(--line);font-size:12px}.video-table th{color:var(--muted)}
@media(max-width:900px){.shell{width:min(100% - 28px,1500px)}.hero{display:block}.pipeline{width:100%;margin-top:30px;overflow-x:auto}.stats{grid-template-columns:repeat(2,1fr)}.task-grid{grid-template-columns:1fr}.history-row{grid-template-columns:1fr 100px 120px}.history-row span:nth-child(3),.history-row span:nth-child(5){display:none}}
@media(max-width:560px){.shell{width:calc(100% - 20px);padding-top:12px}.topbar{align-items:flex-start}.brand small{display:none}.top-actions{gap:5px}.connection{display:none}.ghost{padding:8px 9px}.hero{min-height:0;padding:32px 4px}.hero h1{font-size:38px}.pipeline{grid-template-columns:1fr 1fr;padding:16px}.pipeline i{display:none}.pipeline span{text-align:left;padding:5px}.stats{gap:8px}.stats article{padding:16px}.stats strong{font-size:27px}.content-card{padding:18px 13px}.section-head{display:block}.filters{margin-top:17px;overflow-x:auto}.filters button{white-space:nowrap}.history-row{grid-template-columns:1fr 90px;padding:14px 6px}.history-row span:nth-child(4){display:none}.detail-summary{grid-template-columns:1fr}.modal-backdrop{padding:10px}.detail-card,.login-card{padding:25px 20px}}
`;

export const DASHBOARD_JS = String.raw`
const state={records:[],filter:'all',token:sessionStorage.getItem('mix-dashboard-token')||localStorage.getItem('mix-dashboard-token')||'',timer:null};
const $=id=>document.getElementById(id);const labels={asset_transfer:'素材传输',queued:'等待队列',mixing:'混剪中',output_download:'下载成片',cloud_upload:'上传云管家',cloud_processing:'云端处理中',completed:'已完成',failed:'失败',stopped:'已停止',interrupted:'意外中断',attention:'需要关注'};
const statusLabel={active:'进行中',success:'成功',partial:'部分失败',failed:'失败',stopped:'已停止',interrupted:'意外中断',attention:'需要关注'};
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmtDate(v){if(!v)return'-';return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(v))}
function fmtNum(v){return new Intl.NumberFormat('zh-CN').format(v||0)}
function owner(r){const name=r.uploaderName||'',login=r.uploaderLogin||'';return name&&login&&name!==login?name+' · '+login:name||login||'未识别云管家账号'}
function hasCloudStep(r){return Boolean(r.cloudRequestId)||(r.timeline||[]).some(t=>['cloud_upload','cloud_processing'].includes(t.stage))}
function cloudConfirmed(r){return ['cloud','both'].includes(r.exportTarget)&&r.stage==='completed'&&r.status==='success'&&Boolean(r.cloudRequestId)}
function cloudState(r){
  if(!['cloud','both'].includes(r.exportTarget))return r.stage==='completed'?'仅本地完成（未上传）':(labels[r.stage]||r.stage);
  if(r.stage==='mixing')return'混剪中';
  if(r.stage==='queued')return'等待混剪';
  if(r.stage==='asset_transfer')return'素材传输中';
  if(r.stage==='output_download')return'混剪完成（下载中）';
  if(r.stage==='cloud_upload')return /等待上传/.test(r.progress.message||'')?'混剪完成·等待上传':'上传中';
  if(r.stage==='cloud_processing')return'上传完·云管家处理中';
  if(r.stage==='completed'){
    if(!r.cloudRequestId)return'未确认上传';
    if(r.status==='success')return'上传成功';
    if(r.status==='partial')return'部分上传成功';
  }
  if(r.stage==='attention'||r.status==='attention')return'云管家结果待确认';
  if(r.stage==='failed'||r.status==='failed')return hasCloudStep(r)?'上传失败':'混剪失败·未上传';
  if(r.stage==='stopped'||r.status==='stopped')return'已停止·未完成上传';
  if(r.stage==='interrupted'||r.status==='interrupted')return'意外中断·上传未确认';
  return labels[r.stage]||r.stage;
}
function cloudTone(r){if(cloudConfirmed(r))return'cloud-success';if(['failed','stopped','interrupted'].includes(r.status))return'cloud-failed';if(['partial','attention'].includes(r.status)||(r.status==='success'&&!r.cloudRequestId))return'cloud-warning';return'cloud-pending'}
function resultState(r){if(r.status==='success'&&['cloud','both'].includes(r.exportTarget)&&!r.cloudRequestId)return'混剪完成';return statusLabel[r.status]||r.status}
function showLogin(show){$('loginModal').classList.toggle('hidden',!show);if(show)setTimeout(()=>$('tokenInput').focus(),50)}
async function api(path){const res=await fetch(path,{headers:{'x-mix-token':state.token}});if(res.status===401){showLogin(true);throw new Error('Token 无效，请重新输入')}if(!res.ok)throw new Error('服务器请求失败');return res.json()}
async function load(){if(!state.token){showLogin(true);return}try{const data=await api('/api/workflows?limit=500');state.records=data.records||[];$('connection').textContent='实时连接';$('connection').className='connection online';$('lastUpdated').textContent='最后更新 '+new Date().toLocaleTimeString('zh-CN');render();schedule()}catch(e){$('connection').textContent='连接失败';$('connection').className='connection';$('loginError').textContent=e.message;schedule(10000)}}
function schedule(delay){clearTimeout(state.timer);const active=state.records.some(r=>r.status==='active');state.timer=setTimeout(load,delay||(active?2000:10000))}
function matches(r){if(state.filter==='all')return true;if(state.filter==='problem')return ['partial','failed','attention','interrupted','stopped'].includes(r.status)||(r.status==='success'&&['cloud','both'].includes(r.exportTarget)&&!r.cloudRequestId);if(state.filter==='success')return cloudConfirmed(r);return r.status===state.filter}
function render(){const today=new Date().toDateString(),active=state.records.filter(r=>r.status==='active'),shown=state.records.filter(matches),history=shown.filter(r=>r.status!=='active');$('statActive').textContent=active.length;$('statSuccess').textContent=state.records.filter(r=>cloudConfirmed(r)&&new Date(r.finishedAt||r.updatedAt).toDateString()===today).length;$('statQueued').textContent=active.filter(r=>r.stage==='queued').length;$('statAttention').textContent=state.records.filter(r=>['partial','failed','attention','interrupted'].includes(r.status)||(r.status==='success'&&['cloud','both'].includes(r.exportTarget)&&!r.cloudRequestId)).length;$('activeList').innerHTML=shown.filter(r=>r.status==='active').map(taskCard).join('');$('activeSection').classList.toggle('hidden',!shown.some(r=>r.status==='active'));$('historyList').innerHTML=history.map(historyRow).join('');$('historyCount').textContent=history.length+' 条记录';$('emptyState').classList.toggle('hidden',shown.length>0);document.querySelectorAll('[data-id]').forEach(el=>el.onclick=()=>openDetail(el.dataset.id))}
function taskCard(r){return '<article class="task-card" data-id="'+esc(r.id)+'"><div class="task-top"><strong>'+esc(r.displayName)+'</strong><span class="badge '+cloudTone(r)+'">'+esc(cloudState(r))+'</span></div><p class="task-owner">'+esc(owner(r))+'</p><p class="task-message">'+esc(r.progress.message)+'</p><div class="progress-track"><div style="width:'+Math.min(100,r.progress.percent||0)+'%"></div></div><div class="progress-caption"><span>'+fmtNum(r.progress.current)+' / '+fmtNum(r.progress.total)+'</span><strong>'+fmtNum(r.progress.percent)+'%</strong></div><div class="task-meta"><span>成功 '+fmtNum(r.succeededVideos)+' · 失败 '+fmtNum(r.failedVideos)+'</span><span>更新 '+fmtDate(r.updatedAt)+'</span></div></article>'}
function historyRow(r){const problem=!cloudConfirmed(r);return '<article class="history-row" data-id="'+esc(r.id)+'"><div class="history-name"><strong>'+esc(r.displayName)+'</strong><small>上传人 '+esc(owner(r))+'</small></div><span class="'+(problem?'result-problem':'result-success')+'">'+esc(resultState(r))+'</span><span class="'+cloudTone(r)+'">'+esc(cloudState(r))+'</span><span>'+fmtNum(r.succeededVideos)+' / '+fmtNum(r.totalVideos)+'</span><span>'+fmtDate(r.finishedAt||r.updatedAt)+'</span></article>'}
function openDetail(id){const r=state.records.find(x=>x.id===id);if(!r)return;const videos=(r.videos||[]).map(v=>'<tr><td>'+esc(v.videoName)+'</td><td>'+esc({pending:'等待',uploading:'上传中',processing:'处理中',success:'成功',failed:'失败'}[v.status]||v.status)+'</td><td>'+esc(v.message||'-')+'</td></tr>').join('');const timeline=(r.timeline||[]).slice().reverse().map(t=>'<div class="timeline-item"><strong>'+esc(labels[t.stage]||t.stage)+' · '+esc(t.message)+'</strong><span>'+fmtDate(t.at)+'</span></div>').join('');$('detailContent').innerHTML='<div class="detail-head"><span class="eyebrow">WORKFLOW DETAIL</span><h2 id="detailTitle">'+esc(r.displayName)+'</h2><p>'+esc(resultState(r))+' · '+esc(r.progress.message)+'</p></div><div class="detail-summary"><div><span>上传人</span><strong>'+esc(owner(r))+'</strong></div><div><span>云管家状态</span><strong class="'+cloudTone(r)+'">'+esc(cloudState(r))+'</strong></div><div><span>整体进度</span><strong>'+fmtNum(r.progress.percent)+'%</strong></div><div><span>视频结果</span><strong>'+fmtNum(r.succeededVideos)+' 成功 / '+fmtNum(r.failedVideos)+' 失败</strong></div><div><span>系统任务 ID</span><strong>'+esc(r.id)+'</strong></div><div><span>开始时间</span><strong>'+fmtDate(r.startedAt)+'</strong></div></div>'+(r.error?'<p class="error-text">'+esc(r.error)+'</p>':'')+'<h3>处理时间线</h3><div class="timeline">'+timeline+'</div>'+(videos?'<h3>视频明细</h3><table class="video-table"><thead><tr><th>视频</th><th>状态</th><th>说明</th></tr></thead><tbody>'+videos+'</tbody></table>':'');$('detailModal').classList.remove('hidden')}
$('loginButton').onclick=async()=>{const token=$('tokenInput').value.trim();if(!token){$('loginError').textContent='请输入服务器 Token';return}state.token=token;sessionStorage.setItem('mix-dashboard-token',token);if($('rememberInput').checked)localStorage.setItem('mix-dashboard-token',token);else localStorage.removeItem('mix-dashboard-token');$('loginError').textContent='';try{await api('/api/auth/check');showLogin(false);load()}catch(e){$('loginError').textContent=e.message}};
$('tokenInput').onkeydown=e=>{if(e.key==='Enter')$('loginButton').click()};$('refreshButton').onclick=load;$('logoutButton').onclick=()=>{state.token='';sessionStorage.removeItem('mix-dashboard-token');localStorage.removeItem('mix-dashboard-token');showLogin(true)};$('closeDetail').onclick=()=>$('detailModal').classList.add('hidden');$('detailModal').onclick=e=>{if(e.target===$('detailModal'))$('detailModal').classList.add('hidden')};$('filters').onclick=e=>{const b=e.target.closest('button');if(!b)return;state.filter=b.dataset.filter;document.querySelectorAll('#filters button').forEach(x=>x.classList.toggle('active',x===b));render()};
if(state.token)showLogin(false);load();
`;
