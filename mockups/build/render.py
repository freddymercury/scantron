#!/usr/bin/env python3
import json, datetime as dt
d=json.load(open('mockups/build/snapshot.json'))
inc=d['incidents']; C=d['counts']

def slim(i):
    return dict(id=i['id'],t=i['type'],lat=i['lat'],lng=i['lng'],loc=i['loc'],h=i['hood'],
        f=i['first'],l=i['last'],ag=i['agencies'],u=i['units'][:8],s=1 if i['sensitive'] else 0,
        p=i.get('probable'),
        o=[dict(src=o['src'],t=o['t'],raw=o['raw'],ro=o.get('raw_orig'),d=o.get('disp_t'),
                sc=o.get('scene_t'),c=o.get('close_t'),dp=o.get('disposition'),
                pr=o.get('prio'),un=o.get('units',[])[:8],sid=o['sid'],al=o.get('alarms'))
           for o in i['obs']],
        sc=i['scores'])
data=dict(counts=C,window=d['window'],generated=d['generated'],rollup=d.get('rollup',{}),
          incidents=sorted([slim(i) for i in inc],key=lambda x:x['l'],reverse=True))
blob=json.dumps(data,separators=(',',':'))

html=open('mockups/live.template.html').read().replace('/*__DATA__*/null', blob)
open('mockups/live.html','w').write(html)
print(f"wrote mockups/live.html  ({len(html)/1024:.0f} KB, {len(inc)} incidents)")
