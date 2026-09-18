#!/usr/bin/env python3
"""Pull real SF dispatch data, normalize, correlate, emit snapshot for the mockup."""
import json, urllib.request, urllib.parse, math, datetime as dt, re, sys
from collections import defaultdict

POLICE="https://data.sf.gov/resource/gnap-fj3t.json"
FIRE  ="https://data.sf.gov/resource/nuek-vuh3.json"
HIST  ="https://data.sf.gov/resource/2zdj-bwza.json"   # historical police, 2014->yesterday
import datetime as _dt
_now=_dt.datetime.now().replace(microsecond=0)
WIN_END   = _now.isoformat(timespec='seconds')
WIN_START = (_now-_dt.timedelta(hours=48)).isoformat(timespec='seconds')

def get(url, **p):
    q=urllib.parse.urlencode(p, safe="$'(),<>= :")
    return json.loads(urllib.request.urlopen(f"{url}?{q}", timeout=90).read())

# ---------- taxonomy (S-A4, abbreviated) ----------
RULES=[(r'FIRE|SMOKE|ALARM|STRUCTURE',        'Fire'),
       (r'MEDICAL|MEDIC|SICK|OVERDOSE|UNCONSC','Medical'),
       (r'TRAFFIC COLLISION|ACCIDENT|VEH.*ACC','Collision'),
       (r'ASSAULT|BATTERY|FIGHT',              'Assault'),
       (r'SHOT|GUN|WEAPON|KNIFE|STAB',         'Weapon'),
       (r'ROBBERY|CARJACK',                    'Robbery'),
       (r'BURGLARY',                           'Burglary'),
       (r'THEFT|SHOPLIFT|STOLEN|LARCENY',      'Theft'),
       (r'DISTURB|NOISE|MENTALLY|FIGHT|AGGRESS','Disturbance'),
       (r'MISSING',                            'Missing Person'),
       (r'HAZARD|GAS|SPILL|WIRE|EXPLOS',       'Hazard'),
       (r'RESCUE|EXTRICAT|WATER',              'Rescue'),
       (r'TRAFFIC|PARKING|VEHICLE|TOW|22500',  'Traffic'),
       (r'WELL.?BEING|WELFARE|SUSPICIOUS|TRESPASS|PROWLER','Public Safety')]
def classify(t):
    t=(t or '').upper()
    for pat,norm in RULES:
        if re.search(pat,t): return norm
    return 'Police Activity'

AFFIN={('Assault','Medical'):.8,('Fire','Medical'):.75,('Collision','Medical'):.85,
       ('Weapon','Medical'):.8,('Rescue','Medical'):.8,('Fire','Hazard'):.7,
       ('Collision','Traffic'):.8}
def type_sim(a,b):
    if a==b: return 1.0
    return AFFIN.get((a,b), AFFIN.get((b,a), 0.15))

def P(s):
    return dt.datetime.fromisoformat(s) if s else None
def hav(a,b):
    if not a or not b: return None
    (la1,lo1),(la2,lo2)=a,b
    R=6371000; p1,p2=math.radians(la1),math.radians(la2)
    dp=p2-p1; dl=math.radians(lo2-lo1)
    h=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(h))

# ---------- fetch ----------
print("fetching police…", file=sys.stderr)
pol=get(POLICE, **{"$where":f"received_datetime between '{WIN_START}' and '{WIN_END}'",
                   "$limit":"4000","$order":"received_datetime"})
print(f"  {len(pol)} police rows", file=sys.stderr)
print("fetching fire…", file=sys.stderr)
fire=get(FIRE, **{"$where":f"received_dttm between '{WIN_START}' and '{WIN_END}'",
                  "$limit":"6000","$order":"received_dttm"})
print(f"  {len(fire)} fire unit-rows", file=sys.stderr)

obs=[]
# police: one row = one observation
for r in pol:
    pt=r.get('intersection_point') or {}
    c=pt.get('coordinates')
    obs.append(dict(src='sf_police_cad', agency='police', sid=r.get('cad_number'),
        t=r.get('received_datetime'), disp_t=r.get('dispatch_datetime'),
        scene_t=r.get('onscene_datetime'), close_t=r.get('close_datetime'),
        raw=r.get('call_type_final_desc') or r.get('call_type_original_desc'),
        raw_orig=r.get('call_type_original_desc'),
        typ=classify(r.get('call_type_final_desc')),
        loc=r.get('intersection_name'), hood=r.get('analysis_neighborhood'),
        lat=c[1] if c else None, lng=c[0] if c else None,
        units=[], prio=r.get('priority_final'), disposition=r.get('disposition'),
        sensitive=str(r.get('sensitive_call')).lower()=='true'))

# fire: MANY unit rows per call_number -> group into one observation (real dedup)
byc=defaultdict(list)
for r in fire: byc[r.get('call_number')].append(r)
for cn,rows in byc.items():
    r=rows[0]; c=(r.get('case_location') or {}).get('coordinates')
    units=sorted({x.get('unit_id') for x in rows if x.get('unit_id')})
    ems = (r.get('call_type') or '').lower().startswith(('medical','traffic collision'))
    obs.append(dict(src='sf_ems_cad' if ems else 'sf_fire_cad',
        agency='ems' if ems else 'fire', sid=cn,
        t=r.get('received_dttm'), disp_t=r.get('dispatch_dttm'),
        scene_t=None, close_t=None, raw=r.get('call_type'), raw_orig=r.get('call_type'),
        typ=classify(r.get('call_type')), loc=r.get('address'),
        hood=r.get('neighborhoods_analysis_boundaries'),
        lat=c[1] if c else None, lng=c[0] if c else None, units=units,
        prio=r.get('final_priority'), disposition=r.get('call_final_disposition'),
        sensitive=False, unit_rows=len(rows), alarms=r.get('number_of_alarms')))

obs=[o for o in obs if o['t']]
obs.sort(key=lambda o:o['t'])
print(f"  {len(obs)} observations after fire unit-row grouping", file=sys.stderr)

# ---------- correlation (S-D1/D2/D3) ----------
W=dict(loc=.35,time=.25,typ=.20,unit=.10,text=.10)
RADIUS=400; BACK=10*60; FWD=15*60
incidents=[]; probable=[]
for o in obs:
    best=None; bestsc=0; bd=None
    if o['lat']:
        for inc in incidents:
            if not inc['lat']: continue
            d=hav((o['lat'],o['lng']),(inc['lat'],inc['lng']))
            if d is None or d>RADIUS: continue
            dtsec=(P(o['t'])-P(inc['first'])).total_seconds()
            if not (-BACK <= dtsec <= FWD): continue
            sl=max(0,1-d/RADIUS)
            if o['loc'] and inc['loc'] and o['loc'].strip().upper()==inc['loc'].strip().upper(): sl=1.0
            st=max(0,1-abs(dtsec)/FWD) if dtsec>=0 else max(0,1-abs(dtsec)/BACK)*.9
            sy=type_sim(o['typ'],inc['type'])
            su=len(set(o['units'])&set(inc['units']))/max(1,len(set(o['units'])|set(inc['units']))) if (o['units'] or inc['units']) else 0
            # FIX: renormalize over APPLICABLE features only, so a feature that
            # cannot fire (unit overlap across agencies, text without transcripts)
            # does not silently cap the achievable score. See S-D2 correction.
            feats=[('loc',sl),('time',st),('typ',sy)]
            if o['units'] and inc['units']: feats.append(('unit',su))
            tot=sum(W[k] for k,_ in feats)
            sc=sum(W[k]*v for k,v in feats)/tot
            if sc>bestsc: bestsc,best,bd=sc,inc,dict(loc=round(sl,2),time=round(st,2),typ=round(sy,2),unit=round(su,2),dist=round(d),applied=[k for k,_ in feats])
    if best and bestsc>=0.85:
        best['obs'].append(o); best['last']=max(best['last'],o['t'])
        if o['agency'] not in best['agencies']: best['agencies'].append(o['agency'])
        best['units']=sorted(set(best['units'])|set(o['units']))
        best['scores'].append(dict(sid=o['sid'],src=o['src'],score=round(bestsc,3),**bd))
    else:
        if best and bestsc>=0.65:
            probable.append(dict(sid=o['sid'],score=round(bestsc,3),**bd))
        incidents.append(dict(id=f"sf_{o['src'][3:6]}_{o['sid']}", type=o['typ'], lat=o['lat'], lng=o['lng'],
            loc=o['loc'], hood=o['hood'], first=o['t'], last=o['t'], agencies=[o['agency']],
            units=list(o['units']), obs=[o], scores=[], sensitive=o['sensitive'],
            probable=round(bestsc,3) if best and bestsc>=0.65 else None))

# ---------- historical rollups (S-H6 shape) from the 12-year dataset ----------
print("fetching 90d rollups…", file=sys.stderr)
H_FROM=(_now-_dt.timedelta(days=90)).strftime('%Y-%m-%dT00:00:00')
daily=get(HIST, **{"$select":"date_trunc_ymd(received_datetime) as d, count(*) as n",
    "$where":f"received_datetime > '{H_FROM}'","$group":"d","$order":"d","$limit":"200"})
hood=get(HIST, **{"$select":"date_trunc_ymd(received_datetime) as d, analysis_neighborhood as h, count(*) as n",
    "$where":f"received_datetime > '{H_FROM}' and analysis_neighborhood IS NOT NULL",
    "$group":"d,h","$order":"d","$limit":"8000"})
types={}
for lbl,days_ in (('7d',7),('30d',30),('90d',90)):
    f=(_now-_dt.timedelta(days=days_)).strftime('%Y-%m-%dT00:00:00')
    types[lbl]=get(HIST, **{"$select":"call_type_final_desc as t, count(*) as n",
        "$where":f"received_datetime > '{f}'","$group":"t","$order":"n DESC","$limit":"14"})
print(f"  {len(daily)} days, {len(hood)} day-hood rows", file=sys.stderr)

json.dump(dict(window=[WIN_START,WIN_END], rollup=dict(daily=daily,hood=hood,types=types), generated=dt.datetime.now().isoformat(),
    counts=dict(police_rows=len(pol), fire_unit_rows=len(fire), observations=len(obs),
                incidents=len(incidents), probable=len(probable),
                multi_source=sum(1 for i in incidents if len(i['obs'])>1),
                cross_agency=sum(1 for i in incidents if len(i['agencies'])>1),
                sensitive=sum(1 for i in incidents if i['sensitive'])),
    incidents=incidents), open('mockups/build/snapshot.json','w'), default=str)
c=json.load(open('mockups/build/snapshot.json'))['counts']
for k,v in c.items(): print(f"  {k:18s} {v}")
