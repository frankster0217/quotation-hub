// Read-only invoice email lookup. Existing AR writes and invoice issuance stay in their original tools.
const AR_INVOICE_EMAIL_API='https://portolink-invoice-hub.netlify.app/.netlify/functions/amego';
const arInvoiceEmailCache=new Map();
let arInvoiceEmailPin='';
let arInvoiceEmailBusy=false;
let arInvoiceEmailGeneration=0;

function arInvoiceNumber(rec){return String(rec.invoice_number||'').trim().toUpperCase();}
function arInvoiceEmailsUnlocked(){return !!arInvoiceEmailPin;}

function arExactInvoice(result,number){
  if(result?.message==='PIN_ERROR'||result?.msg==='PIN_ERROR')throw new Error('PIN_ERROR');
  const data=result?.data;
  const invoices=Array.isArray(data)?data:Array.isArray(data?.data)?data.data:data?[data]:[];
  const matches=invoices.filter(inv=>String(inv.invoice_number||inv.InvoiceNumber||'').trim().toUpperCase()===number);
  if(matches.length!==1)throw new Error('找不到唯一對應的發票');
  const inv=matches[0];
  const email=inv.buyer_email_address??inv.BuyerEmailAddress;
  if(typeof email!=='string')throw new Error('發票未提供 Email 欄位，無法確認');
  return {state:'loaded',email:email.trim(),taxId:String(inv.buyer_identifier||inv.BuyerIdentifier||'').trim()};
}

function arInvoiceEmailResult(rec){
  const number=arInvoiceNumber(rec);
  if(!/^[A-Z]{2}\d{8}$/.test(number))return {state:'unlinked'};
  const result=arInvoiceEmailCache.get(number)||{state:'idle'};
  const expected=String(rec.tax_id||'').trim();
  if(result.state==='loaded'&&expected&&result.taxId!==expected){
    return {state:'error',message:'發票統編與此 AR 不符，未顯示 Email'};
  }
  return result;
}

function arInvoiceEmailSearchText(rec){
  const result=arInvoiceEmailResult(rec);
  return result.state==='loaded'?result.email:'';
}

function arRenderInvoiceEmail(rec,parent){
  const row=document.createElement('div');row.className='ar-email-row';
  const number=arInvoiceNumber(rec);
  const invoice=document.createElement('div');
  invoice.textContent='發票：'+(number||'未記錄發票號碼');row.appendChild(invoice);
  const detail=document.createElement('div');row.appendChild(detail);
  const result=arInvoiceEmailResult(rec);
  if(result.state==='loaded'){
    detail.appendChild(document.createTextNode('發票 Email：'));
    if(result.email){
      if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)){
        const link=document.createElement('a');
        link.href='mailto:'+encodeURIComponent(result.email);link.textContent=result.email;
        detail.appendChild(link);
      }else{detail.appendChild(document.createTextNode(result.email));}
    }else{detail.appendChild(document.createTextNode('未填寫 Email'));}
  }else{
    detail.className=result.state==='error'?'ar-email-error':'ar-email-status';
    detail.textContent=result.state==='unlinked'?'Email：無有效發票號碼，無法確認':
      result.state==='loading'?'Email：查詢中…':
      result.state==='error'?'Email：'+result.message:'Email：尚未讀取';
  }
  parent.appendChild(row);
}

function arResetInvoiceEmails(){
  arInvoiceEmailGeneration++;
  arInvoiceEmailCache.clear();arInvoiceEmailPin='';arInvoiceEmailBusy=false;
  document.getElementById('ar-email-pin').value='';
  document.getElementById('ar-email-unlock').hidden=true;
  document.getElementById('ar-email-load').disabled=false;
  document.getElementById('ar-email-progress').textContent='';
  document.querySelectorAll('.ar-email-row').forEach(row=>row.remove());
}

async function arLoadInvoiceEmails(){
  if(arInvoiceEmailBusy||!arInvoiceEmailPin)return;
  const numbers=[...new Set(arRecords.map(arInvoiceNumber))].filter(number=>/^[A-Z]{2}\d{8}$/.test(number)&&arInvoiceEmailCache.get(number)?.state!=='loaded');
  const progress=document.getElementById('ar-email-progress');
  if(!numbers.length){progress.textContent='已讀取所有可對應的發票 Email。';return;}
  const generation=arInvoiceEmailGeneration;
  const pin=arInvoiceEmailPin;
  let completed=0;let failed=0;let pinRejected=false;
  arInvoiceEmailBusy=true;document.getElementById('ar-email-load').disabled=true;
  const update=()=>{if(generation===arInvoiceEmailGeneration){progress.textContent=`已讀取 ${completed} / ${numbers.length} 張發票${failed?'；'+failed+' 張未能確認，可重試':''}`;renderAR();}};
  try{
    for(let i=0;i<numbers.length;i+=2){
      if(generation!==arInvoiceEmailGeneration)break;
      const batch=numbers.slice(i,i+2);
      batch.forEach(number=>arInvoiceEmailCache.set(number,{state:'loading'}));update();
      await Promise.all(batch.map(async number=>{
        try{
          const response=await fetch(AR_INVOICE_EMAIL_API,{
            method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
            body:JSON.stringify({endpoint:'invoice_query',data:{type:'invoice',order_id:'',invoice_number:number},pin}),
            signal:AbortSignal.timeout(20000),
          });
          if(!response.ok)throw new Error('查詢失敗，請稍後重試');
          const result=arExactInvoice(await response.json(),number);
          if(generation===arInvoiceEmailGeneration)arInvoiceEmailCache.set(number,result);
        }catch(error){
          if(error.message==='PIN_ERROR')pinRejected=true;
          if(generation===arInvoiceEmailGeneration){arInvoiceEmailCache.set(number,{state:'error',message:error.message==='PIN_ERROR'?'存取碼錯誤':error.name==='TimeoutError'?'查詢逾時，可重試':error.message});failed++;}
        }finally{completed++;}
      }));
      update();if(pinRejected)break;
    }
  }finally{
    if(generation===arInvoiceEmailGeneration){
      arInvoiceEmailBusy=false;document.getElementById('ar-email-load').disabled=false;
      if(pinRejected){arInvoiceEmailPin='';document.getElementById('ar-email-unlock').hidden=false;progress.textContent='Amego 存取碼錯誤，請重新輸入。';}
    }
  }
}

document.getElementById('ar-email-load').addEventListener('click',()=>{
  if(arInvoiceEmailsUnlocked()){arLoadInvoiceEmails();return;}
  document.getElementById('ar-email-unlock').hidden=false;document.getElementById('ar-email-pin').focus();
});
document.getElementById('ar-email-cancel').addEventListener('click',()=>{
  document.getElementById('ar-email-pin').value='';document.getElementById('ar-email-unlock').hidden=true;
});
document.getElementById('ar-email-unlock').addEventListener('submit',event=>{
  event.preventDefault();
  const input=document.getElementById('ar-email-pin');
  if(!/^[0-9]{8}$/.test(input.value)){input.reportValidity();return;}
  arInvoiceEmailPin=input.value;input.value='';document.getElementById('ar-email-unlock').hidden=true;
  arLoadInvoiceEmails();
});
