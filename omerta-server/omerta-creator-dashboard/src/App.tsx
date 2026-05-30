import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Box, EyeOff, FileClock, Gauge, Layers, LockKeyhole, LogOut, Plus, Rocket, Shield, Smartphone, Trash2 } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Tab = 'overview' | 'ops' | 'privacy' | 'release' | 'containers' | 'wipe' | 'audit' | 'settings';
type Container = { id: string; name: string; api_url: string; ws_url: string; status: string; kill_switch: boolean; remote_config?: any; feature_flags?: any };
type Invite = { id: string; display_code_suffix: string; role: string; used: boolean; container_name: string; created_at: string; code?: string };
type User = { id: string; nick: string; role: string; container_name: string; disabled_at?: string | null; deleted_at?: string | null; created_at: string; device_count?: number; active_devices?: number };
type Device = { id: string; nick: string; container_name: string; device_label: string; revoked_at?: string | null; last_seen: string; active_sessions: number };
type AuditLog = { id: string; actor_type: string; action: string; target_id?: string; created_at: string };
type WipeStatus = { pinSet: boolean; failedAttempts: number; lockedUntil?: string | null; lastVerifiedAt?: string | null; updatedAt?: string | null };
type WipeCommand = { id: string; scope: string; target_id?: string | null; reason?: string | null; created_at: string };
type OpsStatus = { service: string; uptimeSec: number; node: string; activeSessions: number; wipeCommands24h: number; staleDevices7d: number; containers: Array<{status:string; count:number}>; recentAudit: Array<{action:string; created_at:string}>; memory: { rss:number; heapUsed:number } };
type MigrationRequest = { id: string; user_id: string; nick: string; role: string; container_name: string; old_device_label?: string | null; new_device_label: string; recovery_vault_id?: string | null; status: string; decided_by?: string | null; created_at: string; decided_at?: string | null };
type ReleasePolicy = { currentAppVersion:string; minimumAppVersion:string; serverVersion:string; dashboardVersion:string; updateRecommended:boolean; forceUpdate:boolean; maintenanceMode:boolean; killSwitch:boolean; allowedAppVersions:string[]; blockedAppVersions:string[]; message?:string|null; updatedAt?:string };
type ReleaseEvent = { id:string; version:string; kind:string; notes?:string|null; created_at:string };
type PrivacyStatus = { policy: { audit_retention_days:number; runtime_report_retention_days:number; hardening_block_root:boolean; hardening_block_debugger:boolean; hardening_block_emulator:boolean; hardening_limited_mode:boolean; notification_default:'SILENT'|'LIMITED'|'FULL'; dashboard_show_runtime_details:boolean }; runtimeAggregates:Array<{day:string; app_version:string; result:string; policy_action:string; coarse_reason:string; count:number}>; audit:{total:number; redacted:number}; collected:string[]; notCollected:string[]; dashboardRuntimeDetail:string };


async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) }, ...options });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }
function Stat({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) { return <Card><div className="statIcon">{icon}</div><div className="statValue">{value}</div><div className="muted small">{label}</div></Card>; }

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('creator@omerta.local'); const [password, setPassword] = useState(''); const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/creator/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password: password.trim() }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message ? `Login failed: ${err.message}` : 'Login failed');
    }
  }
  return <main className="loginPage"><Card className="loginCard"><div className="brand"><Shield size={28}/><span>OMERTA</span></div><h1>Creator Dashboard</h1><p className="muted">VPN-only control plane for containers, releases, privacy and server operations.</p><form onSubmit={submit} className="form"><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Creator email"/><input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" type="password"/><button>Enter Dashboard</button>{error && <p className="error">{error}</p>}</form></Card></main>;
}
function App() {
  const [authed, setAuthed] = useState(false); const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => { api('/creator/status').then(()=>setAuthed(true)).catch(()=>setAuthed(false)); }, []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  const nav: Array<[Tab, string, React.ReactNode]> = [['overview','Overview',<Activity/>],['ops','Ops',<Gauge/>],['privacy','Privacy',<EyeOff/>],['release','Release',<Rocket/>],['containers','Containers',<Box/>],['wipe','Emergency',<Trash2/>],['audit','Audit',<FileClock/>],['settings','Settings',<Shield/>]];
  return <div className="shell"><aside><div className="brand"><Shield/><span>OMERTA</span></div><div className="sub">Creator</div>{nav.map(([id,label,icon]) => <button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{icon}<span>{label}</span></button>)}<button className="logout" onClick={async()=>{await api('/creator/logout',{method:'POST'}); setAuthed(false)}}><LogOut/>Logout</button></aside><main className="content"><Header tab={tab}/>{tab==='overview' && <Overview/>}{tab==='ops' && <Ops/>}{tab==='privacy' && <Privacy/>}{tab==='release' && <Release/>}{tab==='containers' && <Containers/>}{tab==='wipe' && <WipeGate/>}{tab==='audit' && <Audit/>}{tab==='settings' && <Settings/>}</main></div>;
}
function Header({ tab }: { tab: Tab }) { return <div className="header"><div><h1>{tab[0].toUpperCase()+tab.slice(1).replace('-', ' ')}</h1><p className="muted">Creator-only server and container control. Workspace admins manage users inside the app.</p></div><div className="vpnBadge">VPN ONLY</div></div> }
function Overview(){ const [stats,setStats]=useState<any>(); useEffect(()=>{api<any>('/creator/overview').then(r=>setStats(r.stats)).catch(()=>{})},[]); return <div className="grid4"><Stat label="Containers" value={stats?.containers??'-'} icon={<Layers/>}/><Stat label="Active sessions" value={stats?.activeSessions??'-'} icon={<Shield/>}/><Stat label="Privacy mode" value={'ON'} icon={<EyeOff/>}/><Stat label="Release control" value={'ON'} icon={<Rocket/>}/><Stat label="Audit events" value={stats?.auditEvents??'-'} icon={<FileClock/>}/><Stat label="Wipe commands" value={stats?.wipeCommands??'-'} icon={<Trash2/>}/></div> }

function Ops(){
  const [ops,setOps]=useState<OpsStatus>();
  const load=()=>api<any>('/creator/ops/status').then(r=>setOps(r.ops)).catch(()=>{});
  useEffect(()=>{ load(); const t=setInterval(load,15000); return ()=>clearInterval(t); },[]);
  const mem = ops ? `${Math.round(ops.memory.rss/1024/1024)} MB` : '-';
  return <div className="stack"><div className="grid4"><Stat label="Uptime" value={ops?`${Math.round(ops.uptimeSec/60)} min`:'-'} icon={<Activity/>}/><Stat label="Active sessions" value={ops?.activeSessions??'-'} icon={<Shield/>}/><Stat label="Wipe commands 24h" value={ops?.wipeCommands24h??'-'} icon={<Trash2/>}/><Stat label="Stale devices 7d" value={ops?.staleDevices7d??'-'} icon={<Smartphone/>}/><Stat label="Memory RSS" value={mem} icon={<Gauge/>}/><Stat label="Node" value={ops?.node??'-'} icon={<Box/>}/></div><Card><h2>Container status</h2><div className="table"><div className="tr head"><div>Status</div><div>Count</div></div>{(ops?.containers??[]).map((r,i)=><div className="tr" key={i}><div>{r.status}</div><div>{r.count}</div></div>)}</div></Card><Card><h2>Recent audit</h2><div className="table"><div className="tr head"><div>Action</div><div>Time</div></div>{(ops?.recentAudit??[]).map((r,i)=><div className="tr" key={i}><div>{r.action}</div><div>{new Date(r.created_at).toLocaleString()}</div></div>)}</div></Card></div>
}


function Privacy(){
  const [privacy,setPrivacy]=useState<PrivacyStatus>(); const [msg,setMsg]=useState(''); const [err,setErr]=useState('');
  const load=()=>api<any>('/creator/privacy/status').then(r=>setPrivacy(r.privacy)).catch(()=>{});
  useEffect(()=>{ load(); },[]);
  async function save(patch:any){ setMsg(''); setErr(''); try{ await api('/creator/privacy/policy',{method:'PUT',body:JSON.stringify(patch)}); setMsg('Privacy policy updated.'); load(); } catch { setErr('Could not update privacy policy.'); } }
  async function cleanup(){ setMsg(''); setErr(''); try{ const res=await api<any>('/creator/privacy/cleanup',{method:'POST'}); setMsg(`Cleanup done. Audit deleted: ${res.deleted.audit}, runtime aggregates deleted: ${res.deleted.runtimeAggregates}.`); load(); } catch { setErr('Cleanup failed.'); } }
  if(!privacy) return <Card><p className="muted">Loading privacy posture...</p></Card>;
  const p=privacy.policy;
  const blocked=(privacy.runtimeAggregates??[]).filter(r=>r.policy_action==='block').reduce((n,r)=>n+r.count,0);
  const limited=(privacy.runtimeAggregates??[]).filter(r=>r.policy_action==='limited').reduce((n,r)=>n+r.count,0);
  const passed=(privacy.runtimeAggregates??[]).filter(r=>r.result==='passed').reduce((n,r)=>n+r.count,0);
  return <div className="stack"><Card><h2>Privacy-preserving hardening</h2><p className="muted">Creator can control policy and see aggregate health, but cannot inspect per-person runtime details, IP addresses, device models, fingerprints or recovery phrases.</p>{msg && <p className="success">{msg}</p>}{err && <p className="error">{err}</p>}</Card><div className="grid4"><Stat label="Runtime passed" value={passed} icon={<Shield/>}/><Stat label="Limited mode" value={limited} icon={<EyeOff/>}/><Stat label="Blocked" value={blocked} icon={<AlertTriangle/>}/><Stat label="Audit redacted" value={`${privacy.audit.redacted}/${privacy.audit.total}`} icon={<FileClock/>}/></div><Card><h2>Policy</h2><div className="form compact"><label><input type="checkbox" checked={p.hardening_block_root} onChange={e=>save({hardeningBlockRoot:e.target.checked})}/> Block rooted runtime</label><label><input type="checkbox" checked={p.hardening_block_debugger} onChange={e=>save({hardeningBlockDebugger:e.target.checked})}/> Block debugger</label><label><input type="checkbox" checked={p.hardening_block_emulator} onChange={e=>save({hardeningBlockEmulator:e.target.checked})}/> Block emulator</label><label><input type="checkbox" checked={p.hardening_limited_mode} onChange={e=>save({hardeningLimitedMode:e.target.checked})}/> Allow limited mode instead of exposing details</label><label>Default notification privacy<select value={p.notification_default} onChange={e=>save({notificationDefault:e.target.value})}><option value="SILENT">Silent</option><option value="LIMITED">Limited</option><option value="FULL">Full</option></select></label><label>Audit retention days<input type="number" value={p.audit_retention_days} onChange={e=>save({auditRetentionDays:Number(e.target.value)})}/></label><label>Runtime aggregate retention days<input type="number" value={p.runtime_report_retention_days} onChange={e=>save({runtimeReportRetentionDays:Number(e.target.value)})}/></label><button onClick={cleanup}>Run privacy cleanup</button></div></Card><Card><h2>Data boundaries</h2><div className="grid2"><div><h3>Collected</h3><ul className="checks">{privacy.collected.map(x=><li key={x}>{x}</li>)}</ul></div><div><h3>Not collected</h3><ul className="checks">{privacy.notCollected.map(x=><li key={x}>{x}</li>)}</ul></div></div></Card><Card><h2>Runtime aggregates</h2><div className="table"><div className="tr head"><div>Day</div><div>App</div><div>Result</div><div>Action</div><div>Count</div></div>{privacy.runtimeAggregates.map((r,i)=><div className="tr" key={i}><div>{new Date(r.day).toLocaleDateString()}</div><div>{r.app_version}</div><div>{r.result}</div><div>{r.policy_action}</div><div>{r.count}</div></div>)}</div></Card></div>
}


function Release(){
  const [policy,setPolicy]=useState<ReleasePolicy>(); const [events,setEvents]=useState<ReleaseEvent[]>([]); const [msg,setMsg]=useState(''); const [err,setErr]=useState('');
  const load=()=>api<any>('/creator/release-policy').then(r=>{setPolicy(r.policy); setEvents(r.events)}).catch(()=>{});
  useEffect(()=>{ load(); },[]);
  async function save(patch:Partial<ReleasePolicy>){
    setMsg(''); setErr('');
    try{ await api('/creator/release-policy',{method:'PUT',body:JSON.stringify(patch)}); setMsg('Release policy updated.'); load(); }
    catch{ setErr('Could not update release policy.'); }
  }
  if(!policy) return <Card><p className="muted">Loading release policy...</p></Card>;
  return <div className="stack"><div className="grid4"><Stat label="Current app" value={policy.currentAppVersion} icon={<Rocket/>}/><Stat label="Minimum app" value={policy.minimumAppVersion} icon={<Shield/>}/><Stat label="Server" value={policy.serverVersion} icon={<Box/>}/><Stat label="Dashboard" value={policy.dashboardVersion} icon={<Gauge/>}/></div><Card><h2>Remote update control</h2><div className="form compact"><input value={policy.currentAppVersion} onChange={e=>setPolicy({...policy,currentAppVersion:e.target.value})} placeholder="Current app version"/><input value={policy.minimumAppVersion} onChange={e=>setPolicy({...policy,minimumAppVersion:e.target.value})} placeholder="Minimum app version"/><input value={policy.message??''} onChange={e=>setPolicy({...policy,message:e.target.value})} placeholder="Message to clients"/><label><input type="checkbox" checked={policy.updateRecommended} onChange={e=>setPolicy({...policy,updateRecommended:e.target.checked})}/> Update recommended</label><label><input type="checkbox" checked={policy.forceUpdate} onChange={e=>setPolicy({...policy,forceUpdate:e.target.checked})}/> Force update</label><label><input type="checkbox" checked={policy.maintenanceMode} onChange={e=>setPolicy({...policy,maintenanceMode:e.target.checked})}/> Maintenance mode</label><label><input type="checkbox" checked={policy.killSwitch} onChange={e=>setPolicy({...policy,killSwitch:e.target.checked})}/> Global kill switch</label><button onClick={()=>save(policy)}>Save policy</button></div>{msg && <p className="success">{msg}</p>}{err && <p className="error">{err}</p>}</Card><Card><h2>Recent release events</h2><div className="table"><div className="tr head"><div>Kind</div><div>Version</div><div>Notes</div><div>Time</div></div>{events.map(e=><div className="tr" key={e.id}><div>{e.kind}</div><div>{e.version}</div><div>{e.notes??'-'}</div><div>{new Date(e.created_at).toLocaleString()}</div></div>)}</div></Card></div>
}

function Invites(){ const [rows,setRows]=useState<Invite[]>([]); const [containers,setContainers]=useState<Container[]>([]); const [newCode,setNewCode]=useState(''); const [role,setRole]=useState('USER'); const [containerId,setContainerId]=useState(''); const load=()=>{api<any>('/creator/invites').then(r=>setRows(r.invites)); api<any>('/creator/containers').then(r=>{setContainers(r.containers); setContainerId(v=>v || r.containers[0]?.id || '')})}; useEffect(load,[]); async function create(){const res=await api<any>('/creator/invites',{method:'POST',body:JSON.stringify({containerId,role})}); setNewCode(res.invite.code); load()} return <><Card><h2>Create invite</h2><div className="inline"><select value={containerId} onChange={e=>setContainerId(e.target.value)}>{containers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={role} onChange={e=>setRole(e.target.value)}><option>USER</option><option>SUB_ADMIN</option><option>ADMIN</option></select><button onClick={create}><Plus size={16}/>Create</button></div>{newCode && <div className="codeBox">{newCode}</div>}</Card><Table headers={['Container','Role','Used','Suffix','Created']} rows={rows.map(r=>[r.container_name,r.role,r.used?'Yes':'No','....'+r.display_code_suffix,new Date(r.created_at).toLocaleString()])}/></> }
function UsersView(){ const [rows,setRows]=useState<User[]>([]); const load=()=>api<any>('/creator/users').then(r=>setRows(r.users)).catch(()=>{}); useEffect(()=>{ load(); },[]); async function disable(id:string){await api(`/creator/users/${id}/disable`,{method:'PATCH'}); load()} async function enable(id:string){await api(`/creator/users/${id}/enable`,{method:'PATCH'}); load()} return <Card><div className="table"><div className="tr head"><div>Nick</div><div>Role</div><div>Container</div><div>Devices</div><div>Status</div><div>Action</div></div>{rows.map(r=><div className="tr" key={r.id}><div>{r.nick}</div><div>{r.role}</div><div>{r.container_name}</div><div>{r.active_devices}/{r.device_count}</div><div>{r.deleted_at?'Deleted':r.disabled_at?'Disabled':'Active'}</div><div>{r.disabled_at?<button onClick={()=>enable(r.id)}>Enable</button>:<button onClick={()=>disable(r.id)}>Disable</button>}</div></div>)}</div></Card> }
function Devices(){ const [rows,setRows]=useState<Device[]>([]); const load=()=>api<any>('/creator/devices').then(r=>setRows(r.devices)).catch(()=>{}); useEffect(()=>{ load(); },[]); async function revoke(id:string){await api(`/creator/devices/${id}/revoke`,{method:'PATCH'}); load()} return <Card><div className="table"><div className="tr head"><div>User</div><div>Container</div><div>Device</div><div>Sessions</div><div>Last seen</div><div>Action</div></div>{rows.map(r=><div className="tr" key={r.id}><div>{r.nick}</div><div>{r.container_name}</div><div>{r.device_label}</div><div>{r.active_sessions}</div><div>{new Date(r.last_seen).toLocaleString()}</div><div>{r.revoked_at?<span className="muted">Revoked</span>:<button onClick={()=>revoke(r.id)}>Revoke</button>}</div></div>)}</div></Card> }
function Containers(){
  const [rows,setRows]=useState<Container[]>([]);
  const [name,setName]=useState('main');
  const [apiUrl,setApiUrl]=useState(window.location.origin);
  const [wsUrl,setWsUrl]=useState(window.location.origin.replace(/^http/,'ws') + '/ws');
  const [createAdminInvite,setCreateAdminInvite]=useState(true);
  const [loading,setLoading]=useState(false);
  const [msg,setMsg]=useState('');
  const [err,setErr]=useState('');
  const [inviteCode,setInviteCode]=useState('');
  const load=()=>api<any>('/creator/containers').then(r=>setRows(r.containers)).catch(()=>setErr('Could not load containers.'));
  useEffect(()=>{ load(); },[]);
  async function create(){
    setLoading(true); setMsg(''); setErr(''); setInviteCode('');
    try{
      const res=await api<any>('/creator/containers',{method:'POST',body:JSON.stringify({name,apiUrl,wsUrl,createAdminInvite})});
      setMsg(`Container ${res.container.name} created.`);
      if(res.firstAdminInvite?.code) setInviteCode(res.firstAdminInvite.code);
      setName('');
      load();
    }catch(e:any){
      const text=String(e?.message ?? e);
      if(text.includes('CONTAINER_NAME_EXISTS')) setErr('A container with that name already exists. Choose another name.');
      else if(text.includes('validation')) setErr('Check name, API URL and WS URL. Name can use letters, numbers, dash and underscore.');
      else setErr(text || 'Could not create container.');
    }finally{ setLoading(false); }
  }
  async function toggleKill(c:Container){
    setErr(''); setMsg('');
    try{ await api(`/creator/containers/${c.id}`,{method:'PATCH',body:JSON.stringify({killSwitch:!c.kill_switch})}); setMsg(`${c.name} updated.`); load(); }
    catch(e:any){ setErr(String(e?.message ?? e)); }
  }
  return <div className="stack"><Card><h2>Create container</h2><p className="muted">Creates an Omerta app container/workspace on this server. Admin users are then created from the app with invite codes.</p><div className="form compact"><label>Container name<input value={name} onChange={e=>setName(e.target.value)} placeholder="main"/></label><label>API URL<input value={apiUrl} onChange={e=>setApiUrl(e.target.value)} placeholder="https://api.example.com"/></label><label>WebSocket URL<input value={wsUrl} onChange={e=>setWsUrl(e.target.value)} placeholder="wss://api.example.com"/></label><label className="checkRow"><input type="checkbox" checked={createAdminInvite} onChange={e=>setCreateAdminInvite(e.target.checked)}/> Create first admin invite code</label><button disabled={loading || !name || !apiUrl || !wsUrl} onClick={create}><Plus size={16}/>{loading?'Creating...':'Create container'}</button></div>{msg && <p className="success">{msg}</p>}{err && <p className="error">{err}</p>}{inviteCode && <div className="codeBox"><div className="muted small">First admin invite code</div>{inviteCode}</div>}</Card><Card><h2>Containers</h2><div className="table"><div className="tr head"><div>Name</div><div>API</div><div>Status</div><div>Kill switch</div><div>Action</div></div>{rows.map(r=><div className="tr" key={r.id}><div>{r.name}</div><div>{r.api_url}</div><div>{r.status}</div><div>{r.kill_switch?'ON':'OFF'}</div><div><button onClick={()=>toggleKill(r)}>{r.kill_switch?'Disable':'Enable'} kill</button></div></div>)}</div></Card></div>
}

function Migrations(){
  const [rows,setRows]=useState<MigrationRequest[]>([]); const [msg,setMsg]=useState(''); const [err,setErr]=useState('');
  const load=()=>api<any>('/creator/device-migrations').then(r=>setRows(r.migrations)).catch(()=>{});
  useEffect(()=>{ load(); const t=setInterval(load,15000); return ()=>clearInterval(t); },[]);
  async function decide(id:string,status:'APPROVED'|'DENIED'){
    setMsg(''); setErr('');
    try{ await api(`/creator/device-migrations/${id}/decision`,{method:'POST',body:JSON.stringify({status})}); setMsg(`Migration ${status.toLowerCase()}. Group key rotation queued when needed.`); load(); }
    catch{ setErr('Could not update migration request. It may already be decided.'); }
  }
  return <div className="stack"><Card><h2>Device migration approval</h2><p className="muted">Used when a user restores with recovery phrase on a new phone. Approval does not expose plaintext; it only allows future key fanout/rotation to the new device.</p>{msg && <p className="success">{msg}</p>}{err && <p className="error">{err}</p>}</Card><Card><div className="table"><div className="tr head"><div>User</div><div>Container</div><div>New device</div><div>Vault</div><div>Status</div><div>Requested</div><div>Action</div></div>{rows.map(r=><div className="tr" key={r.id}><div>{r.nick}<br/><span className="muted small">{r.role}</span></div><div>{r.container_name}</div><div>{r.new_device_label}</div><div>{r.recovery_vault_id?'Yes':'No'}</div><div>{r.status}</div><div>{new Date(r.created_at).toLocaleString()}</div><div>{r.status==='PENDING'?<span className="inline"><button onClick={()=>decide(r.id,'APPROVED')}>Approve</button><button className="dangerButton" onClick={()=>decide(r.id,'DENIED')}>Deny</button></span>:<span className="muted">{r.decided_at?new Date(r.decided_at).toLocaleString():'-'}</span>}</div></div>)}</div></Card></div>
}

function WipeGate(){
  const [status,setStatus]=useState<WipeStatus>(); const [commands,setCommands]=useState<WipeCommand[]>([]); const [containers,setContainers]=useState<Container[]>([]); const [users,setUsers]=useState<User[]>([]); const [devices,setDevices]=useState<Device[]>([]);
  const [newPin,setNewPin]=useState(''); const [scope,setScope]=useState('all'); const [targetId,setTargetId]=useState(''); const [pin,setPin]=useState(''); const [confirm,setConfirm]=useState(''); const [reason,setReason]=useState(''); const [msg,setMsg]=useState(''); const [err,setErr]=useState('');
  const load=()=>{api<any>('/creator/wipe/status').then(r=>setStatus(r.wipe)); api<any>('/creator/wipe/commands').then(r=>setCommands(r.commands)); api<any>('/creator/containers').then(r=>setContainers(r.containers)); api<any>('/creator/users').then(r=>setUsers(r.users)); api<any>('/creator/devices').then(r=>setDevices(r.devices));};
  useEffect(load,[]);
  const targets = scope==='container' ? containers.map(x=>[x.id,x.name]) : scope==='user' ? users.map(x=>[x.id,`${x.nick} / ${x.container_name}`]) : scope==='device' ? devices.map(x=>[x.id,`${x.nick} / ${x.device_label}`]) : [];
  async function savePin(){setErr('');setMsg('');try{await api('/creator/wipe/pin',{method:'PUT',body:JSON.stringify({pin:newPin})});setNewPin('');setMsg('Wipe PIN updated.');load();}catch(e){setErr('Could not update PIN. Use 4-32 allowed characters.')}}
  async function execute(){setErr('');setMsg('');try{await api('/creator/wipe/execute',{method:'POST',body:JSON.stringify({pin,confirmation:confirm,scope,targetId:scope==='all'?undefined:targetId,reason})});setPin('');setConfirm('');setReason('');setMsg('Wipe command created and protected actions applied.');load();}catch(e){setErr('Wipe blocked. Check PIN, confirmation, target, or cooldown.')}}
  return <div className="stack"><Card className="dangerCard"><div className="dangerTitle"><AlertTriangle/><div><h2>Wipe PIN Gate</h2><p className="muted">Remote wipe requires both typed confirmation and a separate wipe PIN. Failed PIN attempts are audit-logged and locked after 3 tries.</p></div></div><div className="grid4"><Stat label="PIN set" value={status?.pinSet?'YES':'NO'} icon={<LockKeyhole/>}/><Stat label="Failed attempts" value={status?.failedAttempts??'-'} icon={<AlertTriangle/>}/><Stat label="Locked until" value={status?.lockedUntil?new Date(status.lockedUntil).toLocaleTimeString():'-'} icon={<Shield/>}/></div></Card><Card><h2>Set / rotate wipe PIN</h2><div className="inline"><input type="password" value={newPin} onChange={e=>setNewPin(e.target.value)} placeholder="New wipe PIN"/><button onClick={savePin}><LockKeyhole size={16}/>Save PIN</button></div></Card><Card><h2>Create wipe command</h2><div className="form compact"><select value={scope} onChange={e=>{setScope(e.target.value);setTargetId('')}}><option value="all">All containers/devices</option><option value="container">One container</option><option value="user">One user</option><option value="device">One device</option></select>{scope!=='all' && <select value={targetId} onChange={e=>setTargetId(e.target.value)}><option value="">Choose target</option>{targets.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>}<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason / note"/><input value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Type WIPE"/><input type="password" value={pin} onChange={e=>setPin(e.target.value)} placeholder="Wipe PIN"/><button className="dangerButton" onClick={execute}><Trash2 size={16}/>Confirm wipe</button></div>{msg && <p className="success">{msg}</p>}{err && <p className="error">{err}</p>}</Card><Table headers={['Scope','Target','Reason','Created']} rows={commands.map(c=>[c.scope,c.target_id??'-',c.reason??'-',new Date(c.created_at).toLocaleString()])}/></div>
}
function Audit(){ const [rows,setRows]=useState<AuditLog[]>([]); useEffect(()=>{api<any>('/creator/audit-logs').then(r=>setRows(r.logs)).catch(()=>{})},[]); return <Table headers={['Actor','Action','Target','Time']} rows={rows.map(r=>[r.actor_type,r.action,r.target_id??'-',new Date(r.created_at).toLocaleString()])}/> }
function Settings(){ return <div className="stack"><Card><h2>Creator dashboard scope</h2><p className="muted">This dashboard is now kept for server, container, release, privacy, emergency and audit controls only. Day-to-day user administration belongs inside the Android app.</p></Card><Card><h2>Active controls</h2><ul className="checks"><li>Server health, readiness and operations status</li><li>Container/workspace creation and kill switch</li><li>Release policy, maintenance mode and force update</li><li>Privacy-preserving hardening controls</li><li>Emergency wipe gate with PIN protection</li><li>Redacted audit logs</li><li>VPS deploy and container management scripts</li></ul></Card><Card><h2>Removed from dashboard scope</h2><ul className="checks"><li>Normal user management</li><li>Invite creation for workspace users</li><li>Device migration/recovery UI</li><li>Per-device runtime/hardening details</li></ul></Card></div> }
function Table({headers,rows}:{headers:string[], rows:(string|number)[][]}){ return <Card><div className="table"><div className="tr head">{headers.map(h=><div key={h}>{h}</div>)}</div>{rows.map((r,i)=><div className="tr" key={i}>{r.map((c,j)=><div key={j}>{c}</div>)}</div>)}</div></Card> }
createRoot(document.getElementById('root')!).render(<App/>);


