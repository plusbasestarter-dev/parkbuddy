import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const headers = {'Content-Type':'application/json','Cache-Control':'no-store'}
const UA = 'ParkBuddy-PriceEngine/1.0 (+https://github.com/plusbasestarter-dev/parkbuddy)'
const MAX_BYTES = 1_500_000

function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers})}
function validRunId(v:unknown){return typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)}
function confidence(level:string){return level==='official'?95:level==='operator'?90:65}
function maxAgeHours(level:string){return level==='official'?24*30:level==='operator'?24*14:24*45}
function priority(level:string){return level==='official'?0:level==='operator'?1:2}
function safeUrl(raw:string){
  try{
    const u=new URL(raw)
    if(u.protocol!=='https:')return null
    const h=u.hostname.toLowerCase()
    if(h==='localhost'||h.endsWith('.local')||h.endsWith('.internal')||/^\d{1,3}(\.\d{1,3}){3}$/.test(h)||h==='::1')return null
    return u
  }catch{return null}
}
async function readLimited(r:Response){
  if(!r.body)return ''
  const reader=r.body.getReader(), chunks:Uint8Array[]=[]
  let total=0
  while(true){
    const {done,value}=await reader.read()
    if(done)break
    if(value){
      total+=value.byteLength
      if(total>MAX_BYTES){try{reader.cancel()}catch{};throw new Error('source response too large')}
      chunks.push(value)
    }
  }
  const all=new Uint8Array(total);let offset=0
  for(const c of chunks){all.set(c,offset);offset+=c.byteLength}
  return new TextDecoder('utf-8',{fatal:false}).decode(all)
}
function canonical(raw:string,contentType:string){
  let s=raw
  if(contentType.includes('html')){
    s=s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
      .replace(/<!--([\s\S]*?)-->/g,' ')
      .replace(/<[^>]+>/g,' ')
  }
  return s.toLowerCase().replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim().slice(0,1_200_000)
}
async function sha256(s:string){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('')
}
function esc(s:string){return s.replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&')}
function amountEvidence(text:string,t:any){
  if(!text)return false
  if(t.tariff_kind==='free'||Number(t.amount)===0){
    return /\b(bezpłatn\w*|bezplatn\w*|free)\b/i.test(text)||/\b0(?:[,.]00)?\s*(?:zł|zl|pln)\b/i.test(text)
  }
  const n=Number(t.amount)
  if(!Number.isFinite(n))return false
  const forms=new Set<string>([
    String(n),
    n.toFixed(2),
    n.toFixed(2).replace('.',','),
    String(n).replace('.',',')
  ])
  const a=[...forms].map(esc).join('|')
  const re=new RegExp('(?:'+a+')\\s*(?:zł|zl|pln)\\b','i')
  return re.test(text)
}
async function updateChunks(db:any,ids:number[],patch:any){
  for(let i=0;i<ids.length;i+=100){
    const {error}=await db.from('parking_tariffs').update(patch).in('id',ids.slice(i,i+100))
    if(error)throw new Error(error.message)
  }
}
async function syncSource(db:any,sourceUrl:string){
  const {error}=await db.rpc('parkbuddy_sync_location_prices',{p_source_url:sourceUrl})
  if(error)throw new Error(error.message)
}

Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return json({error:'POST required'},405)
  try{
    const keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}')
    const secret=keys.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const url=Deno.env.get('SUPABASE_URL')
    if(!secret||!url)return json({error:'server unavailable'},503)
    const db=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}})

    const body=await req.json().catch(()=>null)
    const runId=body?.run_id
    if(!validRunId(runId))return json({error:'valid run_id required'},400)

    const now=new Date().toISOString()
    const {data:run,error:claimError}=await db.from('price_refresh_runs')
      .update({status:'running',started_at:now})
      .eq('id',runId).eq('status','queued')
      .select('id,source_limit').maybeSingle()
    if(claimError)return json({error:'run claim failed'},503)
    if(!run)return json({error:'run unavailable'},409)

    const {data:due,error:dueError}=await db.from('price_source_monitors')
      .select('*').in('status',['active','error']).lte('next_check_at',now)
      .order('next_check_at',{ascending:true}).limit(Math.max(30,run.source_limit*4))
    if(dueError)throw new Error(dueError.message)
    const monitors=(due||[]).sort((a:any,b:any)=>priority(a.authority_level)-priority(b.authority_level)||String(a.next_check_at).localeCompare(String(b.next_check_at))).slice(0,run.source_limit)

    let ok=0,changed=0,failed=0,reverified=0,flagged=0

    for(const m of monitors){
      const source=safeUrl(m.source_url)
      const checkedAt=new Date()
      const checkedIso=checkedAt.toISOString()
      const interval=Math.max(5,Number(m.check_interval_minutes)||1440)
      const nextIso=new Date(checkedAt.getTime()+interval*60000).toISOString()
      if(!source){
        failed++
        await db.from('price_source_monitors').update({
          status:'error',last_checked_at:checkedIso,next_check_at:nextIso,
          last_error:'unsafe source url',consecutive_failures:Number(m.consecutive_failures||0)+1,updated_at:checkedIso
        }).eq('source_url',m.source_url)
        continue
      }

      try{
        const h:any={'User-Agent':UA,'Accept':'text/html,application/json,text/plain,application/pdf;q=0.8,*/*;q=0.2'}
        if(m.etag)h['If-None-Match']=m.etag
        if(m.last_modified)h['If-Modified-Since']=m.last_modified
        const r=await fetch(source.toString(),{headers:h,redirect:'follow',signal:AbortSignal.timeout(12000)})
        const httpStatus=r.status
        const etag=r.headers.get('etag')
        const lastModified=r.headers.get('last-modified')
        let newHash=m.content_hash as string|null
        let text=''
        let changedNow=false
        let notModified=r.status===304

        if(!notModified){
          if(!r.ok)throw new Error('HTTP '+r.status)
          const raw=await readLimited(r)
          text=canonical(raw,r.headers.get('content-type')||'')
          newHash=await sha256(text)
          changedNow=Boolean(m.content_hash && m.content_hash!==newHash)
        }

        const {data:tariffs,error:tariffError}=await db.from('parking_tariffs')
          .select('id,parking_id,tariff_kind,amount,currency,duration_minutes,verification_level,verified_at,freshness_status,source_hash')
          .eq('source_url',m.source_url).is('valid_to',null)
        if(tariffError)throw new Error(tariffError.message)

        const verifiedIds:number[]=[]
        const checkedIds:number[]=[]
        const reviewIds:number[]=[]
        const reviewParking=new Set<string>()

        for(const t of tariffs||[]){
          const sameCapturedHash=Boolean(newHash && t.source_hash===newHash)
          const evidence=!notModified && amountEvidence(text,t)
          const verifiedAgeH=t.verified_at?(checkedAt.getTime()-new Date(t.verified_at).getTime())/3600000:Infinity

          if(notModified && t.source_hash && t.source_hash===m.content_hash){
            verifiedIds.push(t.id)
          }else if(evidence || sameCapturedHash){
            verifiedIds.push(t.id)
          }else if(changedNow || t.freshness_status==='review' || verifiedAgeH>maxAgeHours(t.verification_level)){
            reviewIds.push(t.id);reviewParking.add(t.parking_id)
          }else{
            checkedIds.push(t.id)
          }
        }

        if(verifiedIds.length){
          await updateChunks(db,verifiedIds,{
            verified_at:checkedIso,last_checked_at:checkedIso,next_check_at:nextIso,
            freshness_status:'current',confidence_score:confidence(m.authority_level),
            source_hash:newHash||m.content_hash,source_etag:etag||m.etag,
            source_last_modified:lastModified||m.last_modified,last_http_status:httpStatus,
            consecutive_failures:0
          })
          reverified+=verifiedIds.length
        }
        if(checkedIds.length){
          await updateChunks(db,checkedIds,{
            last_checked_at:checkedIso,next_check_at:nextIso,last_http_status:httpStatus,
            source_etag:etag||m.etag,source_last_modified:lastModified||m.last_modified,
            consecutive_failures:0
          })
        }
        if(reviewIds.length){
          await updateChunks(db,reviewIds,{
            last_checked_at:checkedIso,next_check_at:nextIso,freshness_status:'review',
            last_http_status:httpStatus,source_etag:etag||m.etag,
            source_last_modified:lastModified||m.last_modified,consecutive_failures:0
          })
          flagged+=reviewIds.length
          for(const pid of reviewParking){
            await db.from('parking_price_verification_queue').update({
              status:'needs_manual_review',verification_method:'price_source_change_detector',
              last_checked_at:checkedIso,updated_at:checkedIso,
              notes:'Source changed or current tariff could not be re-confirmed automatically.'
            }).eq('parking_id',pid)
          }
        }

        if(changedNow){
          changed++
          await db.from('price_source_changes').insert({
            source_url:m.source_url,old_hash:m.content_hash,new_hash:newHash,http_status:httpStatus,
            affected_tariffs:(tariffs||[]).length,flagged_tariffs:reviewIds.length,
            resolution:reviewIds.length?'needs_review':'price_unchanged',
            metadata:{etag,last_modified:lastModified}
          })
        }

        await db.from('price_source_monitors').update({
          status:'active',content_hash:newHash||m.content_hash,etag:etag||m.etag,
          last_modified:lastModified||m.last_modified,last_http_status:httpStatus,
          last_checked_at:checkedIso,next_check_at:nextIso,
          last_changed_at:changedNow?checkedIso:m.last_changed_at,
          consecutive_failures:0,last_error:null,updated_at:checkedIso
        }).eq('source_url',m.source_url)

        await syncSource(db,m.source_url)
        ok++
      }catch(e){
        failed++
        const failures=Number(m.consecutive_failures||0)+1
        const retryMinutes=Math.min(Math.max(60,Math.pow(2,Math.min(failures-1,4))*60),Math.max(60,interval))
        const retryIso=new Date(Date.now()+retryMinutes*60000).toISOString()
        const message=String(e instanceof Error?e.message:e).slice(0,500)
        await db.from('price_source_monitors').update({
          status:'error',last_checked_at:checkedIso,next_check_at:retryIso,
          consecutive_failures:failures,last_error:message,updated_at:checkedIso
        }).eq('source_url',m.source_url)
        if(failures>=3){
          await db.from('parking_tariffs').update({
            freshness_status:'error',last_checked_at:checkedIso,next_check_at:retryIso,
            consecutive_failures:failures
          }).eq('source_url',m.source_url).is('valid_to',null)
          await syncSource(db,m.source_url)
        }
      }
    }

    const finalStatus=failed===0?'succeeded':ok>0?'partial':'failed'
    const finish=new Date().toISOString()
    await db.from('price_refresh_runs').update({
      status:finalStatus,sources_seen:monitors.length,sources_ok:ok,sources_changed:changed,
      sources_failed:failed,tariffs_reverified:reverified,tariffs_flagged:flagged,
      finished_at:finish,error_message:failed&&ok===0?'all source checks failed':null
    }).eq('id',runId)

    return json({ok:finalStatus!=='failed',run_id:runId,status:finalStatus,sources:monitors.length,
      sources_ok:ok,sources_changed:changed,sources_failed:failed,
      tariffs_reverified:reverified,tariffs_flagged:flagged})
  }catch(e){
    return json({error:String(e instanceof Error?e.message:e).slice(0,500)},500)
  }
})
