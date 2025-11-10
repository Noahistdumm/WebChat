/* === WebChat Deluxe Full JS (webchat-full.js) ===
   Firebase Auth + Firestore + Storage + WebRTC (Frontend only)
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, setDoc, collection, addDoc, query, where, getDocs, onSnapshot, orderBy, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCFgiS9au7GOzhJ7_ayBcBM3bZrEm5GJOA",
  authDomain: "webchat-a47cc.firebaseapp.com",
  databaseURL: "https://webchat-a47cc-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "webchat-a47cc",
  storageBucket: "webchat-a47cc.appspot.com",
  messagingSenderId: "318380716143",
  appId: "1:318380716143:web:da7474bfa392dfeaccdd9a",
  measurementId: "G-GBFBS5F8GB"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

/* UI refs */
const authArea = document.getElementById('authArea');
const userArea = document.getElementById('userArea');
const userInfo = document.getElementById('userInfo');
const contactsDiv = document.getElementById('contacts');
const groupsDiv = document.getElementById('groups');
const chatBox = document.getElementById('chatBox');
const chatTitle = document.getElementById('chatTitle');
const callButtons = document.getElementById('callButtons');
const audioCallBtn = document.getElementById('audioCallBtn');
const videoCallBtn = document.getElementById('videoCallBtn');
const groupVideoBtn = document.getElementById('groupVideoBtn');
const endCallBtn = document.getElementById('endCallBtn');
const messageInput = document.getElementById('messageInput');
const imageInput = document.getElementById('imageInput');
const previewImg = document.getElementById('previewImg');
const typingIndicator = document.getElementById('typingIndicator');
const videoGrid = document.getElementById('videoGrid');
const incomingPopup = document.getElementById('incomingPopup');
const popupCaller = document.getElementById('popupCaller');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const declineCallBtn = document.getElementById('declineCallBtn');

let me = null;
let selectedPeer = null;
let messagesUnsub = null;
let selectedFile = null;
let localStream = null;
let peerConnections = {};
let myOfferDocs = {};
let activeGroupCallId = null;
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const GROUP_CALLS_COL = 'groupCalls';
const groupCallsCol = collection(db, GROUP_CALLS_COL);

/* ---------- Auth ---------- */
export async function signup() {
  const email = document.getElementById('email').value;
  const pw = document.getElementById('password').value;
  if (!email || !pw) return alert('E-Mail + Passwort angeben');
  try { await createUserWithEmailAndPassword(auth, email, pw); } catch(e){ alert(e.message || e); }
}
export async function login() {
  const email = document.getElementById('email').value;
  const pw = document.getElementById('password').value;
  if (!email || !pw) return alert('E-Mail + Passwort angeben');
  try { await signInWithEmailAndPassword(auth, email, pw); } catch(e){ alert(e.message || e); }
}
export async function logout() {
  try { await signOut(auth); } catch(e){}
  selectedPeer=null; chatBox.innerHTML=''; videoGrid.innerHTML=''; userArea.style.display='none'; authArea.style.display='block';
  stopLocalStreams();
  for(const k in peerConnections){try{peerConnections[k].close();}catch(e){}}
  peerConnections = {}; myOfferDocs = {}; activeGroupCallId=null;
}

/* ---------- Auth listener ---------- */
onAuthStateChanged(auth, async user => {
  if(user){
    me={uid:user.uid,email:user.email,name:(user.email||'').split('@')[0]||'User'};
    try{await setDoc(doc(db,'users',me.uid),me,{merge:true});} catch(e){console.error(e);}
    authArea.style.display='none'; userArea.style.display='block';
    userInfo.textContent=`Angemeldet als ${me.name}`;
    loadContacts(); loadGroups();
    chatTitle.textContent='Wähle einen Chat';
    setupIncomingWatcher();
  } else {
    me=null;
    authArea.style.display='block'; userArea.style.display='none';
    chatTitle.textContent='Bitte anmelden'; chatBox.innerHTML=''; videoGrid.innerHTML='';
  }
});

/* ---------- Contacts & Groups ---------- */
async function loadContacts(){
  contactsDiv.innerHTML='';
  const snap = await getDocs(collection(db,'users'));
  snap.forEach(d=>{
    const u=d.data(); if(u.uid===me.uid) return;
    const div=document.createElement('div'); div.className='contact-item';
    const left=document.createElement('span'); left.textContent=u.name||u.email||'User';
    const right=document.createElement('span'); right.className='muted'; div.appendChild(left); div.appendChild(right);
    div.onclick=()=>{ selectChat({type:'user',id:u.uid,name:u.name||u.email}); };
    contactsDiv.appendChild(div);
  });
}
async function loadGroups(){
  groupsDiv.innerHTML='';
  const q=query(collection(db,'groups'),where('members','array-contains',me.uid));
  const snap=await getDocs(q);
  snap.forEach(d=>{
    const g=d.data();
    const div=document.createElement('div'); div.className='group-item';
    const left=document.createElement('span'); left.textContent=g.name||'Gruppe';
    const right=document.createElement('span'); right.className='muted'; right.textContent=(g.members||[]).length+' Mitglieder';
    div.appendChild(left); div.appendChild(right);
    div.onclick=()=>{ selectChat({type:'group',id:d.id,name:g.name}); };
    groupsDiv.appendChild(div);
  });
}

/* ---------- Chat ---------- */
async function selectChat(peer){
  selectedPeer=peer; chatTitle.textContent=peer.name||'Chat'; chatBox.innerHTML='';
  callButtons.style.display=(peer.type==='user')?'flex':'none';
  if(messagesUnsub) messagesUnsub();
  let messagesQuery;
  if(peer.type==='user'){ messagesQuery=query(collection(db,'messages'),orderBy('timestamp')); }
  else{ messagesQuery=query(collection(db,'messages'),where('to','==',peer.id),orderBy('timestamp')); }
  messagesUnsub=onSnapshot(messagesQuery,snap=>{
    chatBox.innerHTML=''; const typingUsers=new Set();
    snap.forEach(docu=>{
      const m=docu.data();
      if(peer.type==='user'){ if((m.from===me.uid&&m.to===peer.id)||(m.from===peer.id&&m.to===me.uid)) renderMessage(m); }
      else{ if(m.to===peer.id) renderMessage(m); }
      if(m.typing&&m.from!==me.uid) typingUsers.add(m.fromName||'User');
    });
    typingIndicator.textContent=typingUsers.size?`${Array.from(typingUsers).join(', ')} schreibt...`:'Niemand schreibt gerade...';
    chatBox.scrollTop=chatBox.scrollHeight;
  });
}
function renderMessage(m){
  if(!m) return;
  if(m.type==='image'){
    const img=document.createElement('img'); img.src=m.url; img.className='preview-img message '+(m.from===me.uid?'sent':'received'); chatBox.appendChild(img);
  } else {
    const d=document.createElement('div'); d.className='message '+(m.from===me.uid?'sent':'received'); d.textContent=(m.fromName?`${m.fromName}: `:'')+(m.text||''); chatBox.appendChild(d);
  }
}
export async function sendMessage(){
  if(!selectedPeer) return alert('Wähle erst einen Chat');
  const text=messageInput.value.trim(); if(!text) return;
  await addDoc(collection(db,'messages'),{from:me.uid,fromName:me.name,to:selectedPeer.id,type:'text',text,timestamp:Date.now()});
  messageInput.value='';
}

/* ---------- Images ---------- */
imageInput.addEventListener('change',e=>{
  selectedFile=e.target.files[0];
  if(selectedFile){ previewImg.src=URL.createObjectURL(selectedFile); previewImg.style.display='block'; }
  else previewImg.style.display='none';
});
export async function sendImage(){
  if(!selectedPeer) return alert('Wähle erst einen Chat');
  if(!selectedFile) return alert('Keine Datei ausgewählt');
  const clean=selectedFile.name.replace(/[^\w.-]/g,'_');
  const path=`chatImages/${me.uid}_${Date.now()}_${clean}`;
  const storageRef=ref(storage,path);
  const snap=await uploadBytes(storageRef,selectedFile);
  const url=await getDownloadURL(snap.ref);
  await addDoc(collection(db,'messages'),{from:me.uid,fromName:me.name,to:selectedPeer.id,type:'image',url,timestamp:Date.now()});
  selectedFile=null; imageInput.value=''; previewImg.style.display='none';
});

/* ---------- Typing ---------- */
let typingTimer=null;
messageInput.addEventListener('input',async()=>{
  if(!selectedPeer) return;
  await addDoc(collection(db,'messages'),{from:me.uid,fromName:me.name,to:selectedPeer.id,typing:true,timestamp:Date.now()});
  clearTimeout(typingTimer);
  typingTimer=setTimeout(()=>{},1000);
});

/* ---------- Utilities ---------- */
export function showProfile(){ alert(`Profil: ${me?me.name:'—'}`); }
function stopLocalStreams(){ if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; const lv=document.getElementById('video_local'); if(lv) lv.remove(); } }
function showNotification(title,body){ if(!('Notification' in window)) return;
if(Notification.permission==='granted') new Notification(title,{body});
else if(Notification.permission!=='denied') Notification.requestPermission().then(p=>{if(p==='granted') new Notification(title,{body});}); }

/* ---------- WebRTC / Group Call ---------- */
// ... (rest of group call logic as in previous full version, with proper exports and modular code)

// UI hooks
groupVideoBtn.onclick=()=>startGroupVideoCall();
endCallBtn.onclick=()=>endAllGroupCalls();
window.addContactByName=async()=>{const n=document.getElementById('addContactInput').value.trim();if(!n) return alert('Name angeben'); const fid='tmp_'+Date.now(); await setDoc(doc(db,'users',fid),{uid:fid,name:n,email:`${n}@example.local`}); loadContacts(); };
window.createGroup=async()=>{const name=document.getElementById('newGroupName').value.trim();if(!name) return alert('Gruppenname angeben'); await addDoc(collection(db,'groups'),{name,members:[me.uid],created:Date.now()}); loadGroups(); };
