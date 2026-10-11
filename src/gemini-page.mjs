/**
 * Everything `review-video` knows about the Gemini web app, in one place: when Gemini's UI
 * changes, this is the file to fix. Each `*Script` is page JavaScript the Chrome driver runs
 * verbatim with Claude in Chrome's javascript tool. Every script stays under the tool's 45s
 * limit and returns one line, `CAPCUTCTL {json}`, that review-video reads back from the
 * driver's tool results (never from the driver's own words).
 */

export const GEMINI_URL = 'https://gemini.google.com/app';

export const SELECTORS = {
  editor: 'rich-textarea .ql-editor',
  send: 'button[aria-label="Send message"]',
  stop: 'button[aria-label^="Stop"]',
  modePicker: 'button[aria-label^="Open mode picker"]',
  modeItem: 'gem-menu-item[role=menuitem]',
  uploadMenu: 'button[aria-label="Upload & tools"]',
  // The documents input accepts video; the other one is image/* only.
  fileInput: 'input[type=file]:not([accept="image/*"])',
  attachment: 'uploader-file-preview',
  attachmentLoading: 'uploader-file-preview .loading',
  response: 'model-response',
  signIn: 'a[href*="accounts.google.com/ServiceLogin"], a[aria-label^="Sign in"]',
  account: 'a[aria-label*="Google Account"]',
};

/** The strongest choice in the mode picker, best first. Matched against each item's first word. */
export const MODE_PREFERENCE = ['Ultra', 'Pro', 'High', 'Thinking'];

/** Marker the driver keeps in the tab title, so the CLI can bring that one tab to the front. */
export const titleMarker = run => `capcutctl-${run}`;

// The label the driver's `find` resolves to a file_upload ref.
export const UPLOAD_LABEL = 'capcutctl-upload';

// Gemini's answer is read back as base64 slices: small enough that the javascript tool never
// truncates them, and opaque to the driver, so text a video steers Gemini into writing can
// never read as instructions to the session holding the browser.
export const CHUNK = 900;

const S = JSON.stringify(SELECTORS);
const helpers = `const $=${S};const sleep=ms=>new Promise(r=>setTimeout(r,ms));const out=o=>'CAPCUTCTL '+JSON.stringify(o);`;

/**
 * Wait for the app, refuse on a login wall, keep the title marker, pick the strongest mode and
 * expose the file input under UPLOAD_LABEL. `followUp` skips the mode and the upload.
 */
export function prepareScript(run, { followUp = false } = {}) {
  return `await (async()=>{${helpers}
const mark=${JSON.stringify(titleMarker(run))};
const t0=Date.now();
while(Date.now()-t0<20000&&!document.querySelector($.editor)){if(document.querySelector($.signIn)&&!document.querySelector($.account))return out({state:'login'});await sleep(500);}
if(!document.querySelector($.editor))return out({state:document.querySelector($.signIn)?'login':'no-editor',href:location.href});
const keep=()=>{if(!document.title.startsWith(mark))document.title=mark+' '+document.title;};
keep();if(!window.__capcutctlTitle)window.__capcutctlTitle=setInterval(keep,500);
while(Date.now()-t0<30000&&document.visibilityState!=='visible')await sleep(500);
if(document.visibilityState!=='visible')return out({state:'hidden'});
${followUp ? "return out({state:'ready',href:location.href});" : ''}
const pick=${JSON.stringify(MODE_PREFERENCE)};
let model=null;
const picker=document.querySelector($.modePicker);
if(picker){picker.click();await sleep(900);
 const items=[...document.querySelectorAll($.modeItem)].filter(e=>e.getAttribute('aria-disabled')!=='true');
 const word=e=>e.textContent.trim().split(/\\s+/)[0];
 let best=null;for(const p of pick){best=items.find(e=>word(e)===p);if(best)break;}
 if(best&&!best.classList.contains('selected')){best.click();await sleep(900);picker.click();await sleep(900);}
 const chosen=[...document.querySelectorAll($.modeItem)].filter(e=>e.classList.contains('selected')).map(e=>e.textContent.trim().replace(/\\s+/g,' '));
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(300);
 model=chosen.join(' + ')||picker.getAttribute('aria-label');}
const up=document.querySelector($.uploadMenu);if(up){up.click();await sleep(1000);}
const input=document.querySelector($.fileInput);
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
if(!input)return out({state:'no-file-input',model});
input.setAttribute('aria-label',${JSON.stringify(UPLOAD_LABEL)});
return out({state:'ready',model,href:location.href});})()`;
}

/** Until every attachment has finished processing (≤30s per call). */
export function uploadWaitScript(expected) {
  return `await (async()=>{${helpers}
const t0=Date.now();
const n=()=>document.querySelectorAll($.attachment).length;
while(Date.now()-t0<30000&&(n()<${expected}||document.querySelector($.attachmentLoading)))await sleep(1000);
const err=[...document.querySelectorAll('[role=alert],.mat-mdc-snack-bar-label')].map(e=>e.innerText.trim()).filter(Boolean).join(' | ');
if(err&&/fail|error|couldn|unable|too large|limit/i.test(err))return out({state:'error',error:err});
if(document.visibilityState!=='visible')return out({state:'hidden',attachments:n()});
return out({state:n()>=${expected}&&!document.querySelector($.attachmentLoading)?'ready':'uploading',attachments:n()});})()`;
}

/** Type the message and send it. */
export function sendScript(message) {
  return `await (async()=>{${helpers}
const ed=document.querySelector($.editor);if(!ed)return out({state:'no-editor'});
ed.focus();document.execCommand('insertText',false,${JSON.stringify(message)});await sleep(600);
const send=document.querySelector($.send);if(!send||send.disabled)return out({state:'send-disabled'});
const before=document.querySelectorAll($.response).length;
send.click();
const t0=Date.now();while(Date.now()-t0<15000&&!document.querySelector($.stop)&&document.querySelectorAll($.response).length===before)await sleep(500);
return out({state:'sent',responsesBefore:before});})()`;
}

/**
 * Until the answer is complete: no stop button and the text unchanged for 4s (≤30s per call).
 * A short answer that reads like a limit message is `quota`.
 */
export function answerWaitScript() {
  return `await (async()=>{${helpers}
const text=()=>{const r=[...document.querySelectorAll($.response)].at(-1);return r?r.innerText:'';};
const t0=Date.now();let last=text(),since=Date.now();
while(Date.now()-t0<30000){await sleep(1000);const now=text();if(now!==last){last=now;since=Date.now();}
 if(!document.querySelector($.stop)&&now.length&&Date.now()-since>=4000)break;}
const busy=Boolean(document.querySelector($.stop))||Date.now()-since<4000||!last.length;
if(busy)return out({state:'generating',chars:last.length});
const r=[...document.querySelectorAll($.response)].at(-1);
const code=r.querySelector('pre code, code-block code');
if(last.length<600&&/limit|quota|try again later|too many|reached|unavailable/i.test(last))return out({state:'quota'});
const bytes=new TextEncoder().encode(JSON.stringify({raw:last,json:code?code.innerText:null}));
let bin='';for(let i=0;i<bytes.length;i+=8192)bin+=String.fromCharCode(...bytes.subarray(i,i+8192));
window.__capcutctlAnswer=btoa(bin);
return out({state:'done',href:location.href,chunks:Math.ceil(window.__capcutctlAnswer.length/${CHUNK})});})()`;
}

/** One base64 slice of the saved answer. `i` may be a placeholder the driver fills. */
export function chunkScript(i) {
  return `(()=>{const i=${i};return 'CAPCUTCTL_CHUNK '+i+' '+(window.__capcutctlAnswer||'').slice(i*${CHUNK},(i+1)*${CHUNK});})()`;
}
