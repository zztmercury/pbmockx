(function(){
var mode=window.__PBMOCKX_MODE||'res',container=document.getElementById('container'),bridge=null;
var pb=window.location.pathname.replace(/\/public\/.*$/,''); if(!pb)pb='';
function H(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function hint(m){container.innerHTML='<div class="hint">'+H(m)+'</div>';}
function err(m){container.innerHTML='<div class="error">'+H(m)+'</div>';}
function load(m){container.innerHTML='<div class="loading">'+H(m||'Decoding...')+'</div>';}

function handle(session){
  if(!session){hint('No session selected');return;}
  var ds=mode==='req'?{b:session.req&&session.req.base64,h:session.req&&session.req.headers}:{b:session.res&&session.res.base64,h:session.res&&session.res.headers};
  if(!ds){hint('No data');return;}
  var ct=(ds.h&&(ds.h['content-type']||ds.h['Content-Type']))||'';
  if(!/protobuf/i.test(ct)){hint(/json/i.test(ct)?'JSON — use the Body tab':'Not Protobuf ('+(ct||'none')+')');return;}
  if(!ds.b){hint('No body');return;}
  load('Decoding...');
  var desc=(ct.match(/desc\s*=\s*"([^"]+)"/i)||ct.match(/desc\s*=\s*([^\s;]+)/i)||[])[1];
  var mt=(ct.match(/messageType\s*=\s*"([^"]+)"/i)||ct.match(/messageType\s*=\s*([^\s;]+)/i)||[])[1];
  fetch(pb+'/cgi-bin/decode-pb',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base64:ds.b,desc:desc,messageType:mt,delimited:/delimited\s*=\s*true/i.test(ct),contentType:ct})})
  .then(function(r){return r.json();})
  .then(function(r){
    if(r.error){err('Decode error: '+H(r.error));return;}
    if(r.protocol==='json'){hint('JSON — use the Body tab');return;}
    if(r.data){renderTree(r.data);}else{hint('No decoded data');}
  }).catch(function(e){err('Request failed: '+e.message);});
}

function renderTree(tree){
  container.innerHTML='';
  if(Array.isArray(tree)){
    for(var i=0;i<tree.length;i++){var h=document.createElement('div');h.className='msg-hdr';h.textContent=tree[i].messageType+' ['+i+']';container.appendChild(h);container.appendChild(renderNodes(tree[i].fields));}
    return;
  }
  var h=document.createElement('div');h.className='msg-hdr';h.textContent=tree.messageType;container.appendChild(h);container.appendChild(renderNodes(tree.fields));
}

function renderNodes(fields){
  var n=document.createElement('div');n.className='tree-node';
  if(!fields||!fields.length)return n;
  for(var i=0;i<fields.length;i++)n.appendChild(renderField(fields[i]));
  return n;
}

function renderField(f){
  var w=document.createElement('div');w.className='tree-node';
  var row=document.createElement('div');row.className='field-row';
  var hasChildren=(f.fields&&f.fields.length>0)||(f.items&&f.items.length>0);
  if(hasChildren){row.classList.add('expandable');w.classList.add('collapsed');}
  // Build: toggle name (type) = value
  var html='<span class="toggle"></span>';
  html+='<span class="fname">'+H(f.name)+(f.name.charAt(0)==='['?'':'<span class="fnum">#'+f.id+'</span>')+'</span> ';
  var typeLabel=f.kind==='any'&&f.anyType?'Any → '+f.anyType:f.kind+(f.type?' '+f.type:'');
  html+='<span class="ftype">('+H(typeLabel)+')</span>';
  // Value
  if(f.kind==='scalar'){
    if(f.value==null||f.value===undefined){html+=' <span class="unset">(unset)</span>';}
    else if(typeof f.value==='string'){html+=' <span class="fval s">= "'+H(f.value)+'"</span>';}
    else{html+=' <span class="fval n">= '+f.value+'</span>';}
  }else if(f.kind==='enum'){
    if(f.rawValue==null||f.rawValue===undefined){html+=' <span class="unset">(unset)</span>';}
    else{html+=' <span class="fval e">= '+f.rawValue+' ('+H(f.value)+')</span>';}
  }else if(f.kind==='bytes'){
    if(!f.value){html+=' <span class="unset">(unset)</span>';}
    else{html+=' <span class="fval b">= '+H(f.value.slice(0,60))+' ('+(f.rawValue||0)+'B)</span>';}
  }else if((f.kind==='message'||f.kind==='any')&&!hasChildren){
    html+=' <span class="unset">(unset)</span>';
  }else if(f.kind==='repeated'&&!hasChildren){
    html+=' <span class="unset">[]</span>';
  }
  row.innerHTML=html;
  w.appendChild(row);
  if(hasChildren){
    var ch=document.createElement('div');ch.className='tree-children';
    if(f.fields)for(var i=0;i<f.fields.length;i++)ch.appendChild(renderField(f.fields[i]));
    if(f.items)for(var i=0;i<f.items.length;i++)ch.appendChild(renderField(f.items[i]));
    w.appendChild(ch);
    row.onclick=function(e){e.stopPropagation();if(w.classList.contains('collapsed')){w.classList.remove('collapsed');w.classList.add('expanded');}else{w.classList.remove('expanded');w.classList.add('collapsed');}};
  }
  return w;
}

function initBridge(b){
  bridge=b;
  if(typeof b.addSessionActiveListener==='function')b.addSessionActiveListener(handle);
  else if(typeof b.on==='function')b.on('sessionActive',handle);
  if(typeof b.getActiveSession==='function'){try{var s=b.getActiveSession();if(s)handle(s);}catch(e){}}
}
if(window.whistleBridge){initBridge(window.whistleBridge);}
else if(window.parent&&typeof window.parent.onWhistleInspectorCustomTabReady==='function'){window.parent.onWhistleInspectorCustomTabReady(initBridge,window);}
else{hint('Waiting for whistle bridge...');setTimeout(function(){if(window.whistleBridge)initBridge(window.whistleBridge);else hint('Whistle bridge not available');},500);}
})();
