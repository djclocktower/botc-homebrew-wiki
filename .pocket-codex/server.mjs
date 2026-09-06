import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
const exec = promisify(execFile);
const MAX_BODY=1024*1024;
export function seal(payload, publicKey) {
  const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]);
  return Buffer.from(JSON.stringify({key:crypto.publicEncrypt({key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},key).toString('base64'),iv:iv.toString('base64'),data:ciphertext.toString('base64')})).toString('base64url');
}
export class CodexProcess {
  constructor({cwd,command='codex',args=['app-server'],env=process.env,onEvent=()=>{}}) {
    this.pending=new Map();this.requests=new Map();this.nextId=1;this.onEvent=onEvent;this.closed=false;
    const clean={...env};for(const k of ['GITHUB_TOKEN','GH_TOKEN','POCKET_BRIDGE_TOKEN'])delete clean[k];
    this.child=spawn(command,args,{cwd,env:clean,stdio:['pipe','pipe','pipe']});
    readline.createInterface({input:this.child.stdout}).on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      if(message.method){
        if(message.id!==undefined)this.requests.set(String(message.id),message);
        if(message.method==='serverRequest/resolved')this.requests.delete(String(message.params?.requestId));
        this.onEvent(message);
      }else if(message.id!==undefined){
        const p=this.pending.get(message.id);if(!p)return;
        this.pending.delete(message.id);clearTimeout(p.timer);
        message.error?p.reject(new Error(message.error.message||JSON.stringify(message.error))):p.resolve(message.result);
      }
    });
    this.child.stderr.on('data',()=>{}); // Never send raw authentication diagnostics to client logs.
    const close=()=>{this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex stopped. Restart the workspace.'));}this.pending.clear();this.onEvent({method:'bridge/disconnected',params:{}});};
    this.child.on('error',close);this.child.on('exit',close);
    this.ready=this.call('initialize',{clientInfo:{name:'pocket_codex',title:'Pocket Codex',version:'0.1.0'},capabilities:{experimentalApi:true}}).then(()=>this.send({method:'initialized'}));
    this.ready.catch(()=>{});
  }
  send(m){if(this.closed)throw Error('Codex is not running');this.child.stdin.write(JSON.stringify(m)+'\n');}
  call(method,params={}){return new Promise((resolve,reject)=>{const id=this.nextId++;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Codex request timed out: '+method));},60000);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  respond(id,result){const r=this.requests.get(String(id));if(!r)throw Error('This approval is no longer pending');this.send({id:r.id,result});this.requests.delete(String(id));}
  stop(){this.child.kill();}
}
async function jsonBody(req){let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function send(res,status,data,type='application/json'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});res.end(type==='application/json'?JSON.stringify(data):data);}
export function createBridge({config,cwd,stateDir,port=8765,host='0.0.0.0',token,githubToken=process.env.GITHUB_TOKEN,codexOptions={},githubApi='https://api.github.com'}) {
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  const secretFile=path.join(stateDir,'bridge-token');
  token ||= fs.existsSync(secretFile)?fs.readFileSync(secretFile,'utf8'):crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(secretFile,token,{mode:0o600});
  let sequence=0,events=[],preview=null,previewLogs='',publishing=false;
  const epoch=crypto.randomUUID();
  const codex=new CodexProcess({cwd,...codexOptions,onEvent:message=>{events.push({seq:++sequence,message});if(events.length>10000)events.splice(0,1000);}});
  const git=async args=>(await exec('git',args,{cwd,maxBuffer:4*1024*1024,env:{...process.env,GITHUB_TOKEN:githubToken||'',GH_TOKEN:githubToken||'',GIT_TERMINAL_PROMPT:'0'}})).stdout;
  const gh=async(method,route,body)=>{const r=await fetch(githubApi+route,{method,headers:{Authorization:'Bearer '+githubToken,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw Error('GitHub '+r.status+': '+(j.message||'Request failed'));return j;};
  const assertIdle=async()=>{if(codex.requests.size)throw Error('Respond to pending Codex requests first');if(activeTurn)throw Error('Wait for the current task to finish');};
  let activeTurn=null;
  const originalEvent=codex.onEvent;codex.onEvent=m=>{if(m.method==='turn/started')activeTurn=m.params.turn?.id;if(m.method==='turn/completed')activeTurn=null;originalEvent(m);};
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/pair'){
        if(!githubToken)throw Error('Codespaces authentication is unavailable. Restart the workspace.');
        const encoded=seal({token,githubToken,codespace:config.codespace||process.env.CODESPACE_NAME,repo:config.repo,pairId:config.pairId,issuedAt:Date.now()},config.publicKey);
        return send(res,200,`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair Pocket Codex</title><style>body{font:18px system-ui;background:#101720;color:#edf5ff;padding:32px;max-width:520px;margin:auto}a{display:block;background:#a4edcf;color:#101720;padding:18px;border-radius:18px;text-decoration:none;margin-top:32px}p{line-height:1.6}</style><h1>Your workspace is ready</h1><p>Return to Pocket Codex to connect this private workspace to the Android device that created it.</p><a href="pocketcodex://pair?data=${encoded}">Connect Android app</a><p>The connection data is encrypted for your device.</p>`,'text/html; charset=utf-8');
      }
      if(!equal(req.headers.authorization,'Bearer '+token))return send(res,401,{error:'Pair your Android app with this workspace first.'});
      if(req.headers.origin)return send(res,403,{error:'Browser-origin API calls are not allowed.'});
      if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ready:!codex.closed,repo:config.repo,epoch,activeTurn,version:'0.1.0'});
      if(req.method==='GET'&&url.pathname==='/events'){
        const after=Number(url.searchParams.get('after')||0);
        return send(res,200,{epoch,cursor:sequence,reset:after>sequence||(events.length&&after<events[0].seq-1),events:events.filter(e=>e.seq>after),pending:[...codex.requests.values()]});
      }
      if(req.method==='POST'&&url.pathname==='/rpc'){
        await codex.ready;
        const {method,params={}}=await jsonBody(req);
        const allowed=new Set(['account/read','account/login/start','account/login/cancel','account/logout','account/rateLimits/read','model/list','thread/start','thread/list','thread/read','thread/resume','turn/start','turn/interrupt']);
        if(!allowed.has(method))return send(res,403,{error:'Unsupported operation'});
        if(method==='account/login/start'&&params.type!=='chatgptDeviceCode')throw Error('Use ChatGPT device sign-in');
        if(['thread/start','thread/resume','turn/start'].includes(method)){
          params.cwd=cwd;params.approvalPolicy='on-request';
          if(method==='turn/start')params.sandboxPolicy={type:'workspaceWrite',writableRoots:[cwd],networkAccess:true};
          else {params.sandbox='workspaceWrite';params.developerInstructions='Work on the website in the current worktree. Do not commit, push, merge, or publish changes; the user reviews and publishes using the app. Do not access or modify Pocket Codex bootstrap files, pairing keys, or authentication files. Start preview servers on a forwarded port (3000, 5173, or 8080) when requested.';}
        }
        return send(res,200,await codex.call(method,params));
      }
      if(req.method==='POST'&&url.pathname==='/respond'){
        const {id,result}=await jsonBody(req);const pending=codex.requests.get(String(id));if(!pending)throw Error('Request already resolved');
        const m=pending.method;
        if(m==='item/commandExecution/requestApproval'||m==='item/fileChange/requestApproval'){
          if(!['accept','decline','cancel'].includes(result?.decision))throw Error('Unsupported approval decision');
        }else if(m==='item/permissions/requestApproval'){
          if(result?.scope!=='turn'||!result?.permissions||Object.keys(result.permissions).length!==0)throw Error('Extra permissions are declined by this client');
        }else if(m==='item/tool/requestUserInput'||m==='tool/requestUserInput'){
          if(!result?.answers||typeof result.answers!=='object')throw Error('Answers required');
        }else if(m==='mcpServer/elicitation/request'){
          if(result?.action!=='decline')throw Error('External elicitation is not supported');
        }else return send(res,400,{error:'Unsupported request; interrupt the task.'});
        codex.respond(id,result);return send(res,200,{ok:true});
      }
      if(req.method==='GET'&&url.pathname==='/git/status'){
        const status=await git(['status','--short']);
        const committed=await git(['diff','--stat',config.baseSha,'HEAD']);
        let diff=await git(['diff','--no-ext-diff',config.baseSha]);
        const untracked=(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
        for(const file of untracked){
          const abs=path.resolve(cwd,file);if(!abs.startsWith(cwd+path.sep))continue;
          const st=fs.lstatSync(abs);if(st.isFile()&&st.size<64000&&!/(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key))$/.test(file)){
            const content=fs.readFileSync(abs);diff+='\nUntracked: '+file+'\n'+(content.includes(0)?'[binary file]':content.toString());
          }else diff+='\nUntracked: '+file+' [contents omitted]\n';
        }
        return send(res,200,{branch:(await git(['branch','--show-current'])).trim(),status,committed,diff:diff.slice(0,300000),truncated:diff.length>300000});
      }
      if(req.method==='POST'&&url.pathname==='/git/publish'){
        const {title}=await jsonBody(req);if(typeof title!=='string'||!title.trim()||title.length>200)throw Error('Enter a title under 200 characters');
        if(publishing)throw Error('Publishing is already running');await assertIdle();publishing=true;
        try{
          if((await git(['branch','--show-current'])).trim()!==config.workBranch)throw Error('Current branch changed. Review it in the workspace.');
          const files=(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
          if(files.some(f=>/(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key)|credentials\.json)$/.test(f)))throw Error('Untracked credential-like files found. Add them to .gitignore before publishing.');
          await git(['add','-A']);
          if((await git(['diff','--cached','--name-only'])).trim())await git(['-c','user.name=Pocket Codex','-c','user.email=pocket-codex@users.noreply.github.com','commit','-m',title]);
          if(!(await git(['diff','--name-only',config.baseSha,'HEAD'])).trim())throw Error('There are no changes to publish');
          await git(['push','-u','origin',config.workBranch]);
          const owner=config.repo.split('/')[0];
          const existing=await gh('GET','/repos/'+config.repo+'/pulls?state=open&head='+encodeURIComponent(owner+':'+config.workBranch));
          const pr=existing[0]||await gh('POST','/repos/'+config.repo+'/pulls',{title,head:config.workBranch,base:config.baseBranch,body:'Website changes prepared with Pocket Codex. Review the diff and checks before merging.',draft:true});
          return send(res,200,{url:pr.html_url});
        }finally{publishing=false;}
      }
      if(req.method==='GET'&&url.pathname==='/preview')return send(res,200,{running:!!preview,logs:previewLogs});
      if(req.method==='POST'&&url.pathname==='/preview'){
        const {command,port:previewPort}=await jsonBody(req);
        if(typeof command!=='string'||command.length>2000)throw Error('Enter a preview command');
        if(![3000,5173,8080].includes(Number(previewPort)))throw Error('Choose port 3000, 5173, or 8080');
        if(preview)throw Error('Stop the existing preview first');
        previewLogs='';const env={...process.env,PORT:String(previewPort)};delete env.GITHUB_TOKEN;delete env.GH_TOKEN;
        preview=spawn('bash',['-lc',command],{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});const child=preview;
        for(const stream of [preview.stdout,preview.stderr])stream.on('data',b=>{previewLogs=(previewLogs+b).slice(-16000);});
        child.on('exit',()=>{if(preview===child)preview=null;});child.on('error',e=>{previewLogs+=e.message;preview=null;});
        return send(res,200,{url:`https://${config.codespace||process.env.CODESPACE_NAME}-${previewPort}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN||'app.github.dev'}`});
      }
      if(req.method==='POST'&&url.pathname==='/preview/stop'){if(preview){try{process.kill(-preview.pid,'SIGTERM');}catch{}preview=null;}return send(res,200,{ok:true});}
      return send(res,404,{error:'Unknown endpoint'});
    }catch(e){if(!res.headersSent)send(res,400,{error:e.message});else res.end();}
  });
  server.headersTimeout=15000;server.requestTimeout=30000;
  return {server,codex,token,start:()=>new Promise(resolve=>server.listen(port,host,resolve)),close:()=>{codex.stop();if(preview){try{process.kill(-preview.pid,'SIGTERM');}catch{}}return new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=JSON.parse(fs.readFileSync(process.argv[2]||path.join(import.meta.dirname,'config.json'),'utf8'));
  const stateDir=path.join(os.homedir(),'.local/share/pocket-codex');
  const bridge=createBridge({config,cwd:config.workDir||'/workspaces/pocket-codex-work',stateDir});
  await bridge.start();console.log('Pocket Codex bridge listening on private port 8765');
  process.on('SIGTERM',()=>bridge.close().then(()=>process.exit()));
}
