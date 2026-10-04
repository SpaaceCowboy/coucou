import { State } from "./state";
import { Bridge } from "./bridge";
import { Sound } from "./sound";

export function releaseQuietApproval() {
  if (!State.quiet || !State.pendingApproval) return;
  releasePendingApproval("Quiet mode");
}

export function releasePendingApproval(reason:string){
  if(!State.pendingApproval)return;
  const request=State.pendingApproval;
  void Bridge.approvalDecline(request.requestId);
  State.recordAlert("integration_claude","approval",`Answer in the terminal (${reason}).`,request.requestId);
  State.pendingApproval=null;State.isPinned=false;
  State.updateTask("integration_claude","question");
}

export function setQuiet(until:number|null) {
  State.settings={...State.settings,quietUntil:until};
  releaseQuietApproval();
  if(State.quiet) Sound.idle();
  State.notify();
  void Bridge.saveSettings(State.settings);
}
