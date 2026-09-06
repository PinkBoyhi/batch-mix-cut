const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('fs'); const os=require('os');const path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'batchmix-ui-audit-'));app.setPath('userData',tmp);
const root=path.resolve(__dirname, '..');
const bundle=fs.readdirSync(root+'/dist/assets').find(x=>x.endsWith('.js'));
const bootstrap=`
window.audit={ledgerCalls:0,ledgerResolved:0,jobListener:null};
const a={id:'a',name:'a.mp4',path:'/audit/a.mp4',kind:'video',durationSeconds:1};
const cfg={projectDir:'/audit',outputDir:'/audit',slots:[{name:'A',assets:[a],sortOrder:0}],bgmAssets:[],bgmRange:{fadeInSeconds:0,fadeOutSeconds:0},bgmTracks:[],maxCombinations:1,outputNamePattern:'成品',exportMode:'video',sourceVolume:1,bgmVolume:1,normalizeLoudness:false,videoProfile:{codec:'h264',audioCodec:'aac',preset:'veryfast',crf:20,canvasMode:'original'},exportTarget:'cloud',draftSlots:[]};
const combo={id:'mix_0001',index:0,slotAssets:{A:a},targetVideoPath:'/audit/videos/成品_001.mp4',targetDraftPath:'/audit/drafts/1'};
window.batchMix={
selectDirectory:async()=>'/audit',createManualProject:async()=>({config:cfg,combinations:[combo],warnings:[]}),
getJob:async(taskId)=>{window.audit.taskId=taskId;return ({id:'audit-job',status:'completed',total:1,completed:1,failed:0,message:'AUDIT_COMPLETE',failures:[]})},
onJobUpdate:(cb)=>{window.audit.jobListener=cb;return ()=>{}},onCloudProgress:()=>()=>{},onUpdateStatus:()=>()=>{},
getRemoteMixSettings:async()=>({serverUrl:'http://127.0.0.1',hasToken:false}),
getUpdateStatus:async()=>({status:'idle',currentVersion:'audit',message:'audit'}),
getCloudSettings:async()=>({baseUrl:'',hasApiToken:false,accountKey:'test',accountName:'audit',hasUploadToken:true}),
getCloudPublishProfiles:async()=>[],
getCloudUploadLedger:async()=>{window.audit.ledgerCalls++;await new Promise(r=>setTimeout(r,100));window.audit.ledgerResolved++;return [{localPath:'/audit/videos/成品_001.mp4',url:'https://example.invalid/already-uploaded.mp4',submitted:true,requestId:'existing-request'}]},
listCloudVideoTypes:async()=>[],listCloudVideoLabels:async()=>[],buildCombinations:async()=>[combo]
};`;
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});
try{
await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<div id="root"></div><script>'+bootstrap+'</script><script type="module">'+fs.readFileSync(root+'/dist/assets/'+bundle,'utf8')+'</script>'));
const waitFor = async (expression) => {
  const deadline = Date.now() + 10_000;
  while (!(await win.webContents.executeJavaScript(expression))) {
    if (Date.now() > deadline) throw new Error(`界面验证超时：${expression}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
await waitFor("Boolean(document.querySelector('button.primary-action'))");
await win.webContents.executeJavaScript(`document.querySelector('button.primary-action').click()`);
await waitFor("window.audit.ledgerResolved === 1 && document.body.innerText.includes('已提交')");
const result=await win.webContents.executeJavaScript(`(()=>{const rows=[...document.querySelectorAll('tbody tr')].map(x=>x.innerText);return {ledgerCalls:window.audit.ledgerCalls,ledgerResolved:window.audit.ledgerResolved,rows,hasCompletedMessage:document.body.innerText.includes('AUDIT_COMPLETE')}})()`);
assert.equal(result.ledgerCalls,1);assert.equal(result.ledgerResolved,1);
assert.ok(result.rows.some(row=>row.includes('已提交')), 'Upload ledger was not restored');
assert.ok(!result.rows.some(row=>row.includes('待上传')), 'Already submitted video was reset');
await win.webContents.executeJavaScript(`window.audit.jobListener({taskId:window.audit.taskId,executionTarget:'local',snapshot:{id:'running-job',status:'running',total:1,completed:0,failed:0,message:'running',failures:[]}})`);
await waitFor("document.querySelectorAll('fieldset:disabled').length === 4");
const locked=await win.webContents.executeJavaScript(`({settings:document.querySelectorAll('fieldset:disabled').length,directory:document.querySelector('button.primary-action').disabled})`);
assert.equal(locked.settings,4);assert.equal(locked.directory,true);
await win.webContents.executeJavaScript(`window.audit.jobListener({taskId:window.audit.taskId,executionTarget:'local',snapshot:{id:'audit-job',startedAt:'2026-09-06T12:00:00Z',status:'completed',total:1,completed:1,failed:0,message:'retry',failures:[]}})`);
await waitFor("window.audit.ledgerResolved === 2 && document.body.innerText.includes('已提交')");
await waitFor("document.body.innerText.includes('请先选择云管家二级分类')");
console.log('界面回归通过：异步上传记录恢复、已提交状态保留、运行中配置锁定、重试后恢复发布流程');
}catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode || 0);}
});
