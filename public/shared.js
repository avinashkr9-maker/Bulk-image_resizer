function listenSSE(jobId,barId,textId,onDone){
  const es=new EventSource(`/progress/${jobId}`);
  es.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.done){document.getElementById(barId).style.width='100%';document.getElementById(textId).textContent=`Done - ${d.total} images processed`;es.close();onDone(d);}
    else{document.getElementById(barId).style.width=(d.percent||0)+'%';document.getElementById(textId).textContent=`Processing ${d.current}/${d.total} - ${d.filename}`;}
  };
  es.onerror=()=>es.close();
}
function triggerDownload(blob,filename){
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}
function setupDrop(dzId,inputId,labelId,multi){
  const dz=document.getElementById(dzId);
  if(!dz)return;
  ['dragenter','dragover'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop',ev=>{
    const files=[...ev.dataTransfer.files].filter(f=>/\.(jpe?g|png|webp)$/i.test(f.name));
    if(files.length) updateDzLabel(dzId,labelId,files.length);
  });
}
function updateDzLabel(dzId,labelId,count){
  const dz=document.getElementById(dzId),el=document.getElementById(labelId);
  if(!dz||!el)return;
  dz.classList.add('has');
  el.textContent=count>1?`${count} images ready`:'1 image ready';
}
function setBtn(id,loading){
  const b=document.getElementById(id);
  if(!b)return;
  if(loading){b.dataset.orig=b.innerHTML;b.disabled=true;b.innerHTML='<svg viewBox="0 0 16 16" style="width:15px;height:15px;stroke:#fff;fill:none;stroke-width:2;animation:spin 1s linear infinite"><circle cx="8" cy="8" r="6" stroke-dasharray="20 18"/></svg> Processing...';}
  else{b.disabled=false;b.innerHTML=b.dataset.orig||b.innerHTML;}
}
function showErr(id,msg){const el=document.getElementById(id);if(el){el.textContent=msg;el.classList.add('vis');}}
function hideErr(id){const el=document.getElementById(id);if(el) el.classList.remove('vis');}
const style=document.createElement('style');
style.textContent='@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(style);
