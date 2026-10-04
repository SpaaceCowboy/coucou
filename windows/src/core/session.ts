import { Bridge } from "./bridge";
import { State } from "./state";
export const sessionOpenLabel=()=>State.capabilities.codexLinks ? "Open chat":"Open folder";
export function openSession(sessionId:string,cwd?:string|null){
  if(State.capabilities.codexLinks)void Bridge.openCodexChat(sessionId);
  else if(cwd)void Bridge.openInVSCode(cwd);
}
export async function copySessionId(button:HTMLElement,sessionId?:string|null){
  if(!sessionId)return;
  try{await navigator.clipboard.writeText(sessionId);button.textContent="Copied";}catch{button.textContent=sessionId;button.setAttribute("title","Select and copy this session identifier");}
}
