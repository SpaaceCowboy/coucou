// Synthetic fixtures for layout review. Imported only by Vite's development mode.
import { State } from "./core/state";
import type { Island } from "./island/island";
export function preview(island:Island){
  const view=new URLSearchParams(location.search).get("preview");if(!view)return false;
  const now=Date.now();
  State.settings.reducedMotion=view.includes("reduced");
  State.settings.autoCloseInterval=3600;
  if(view.includes("wayland")){State.capabilities={...State.capabilities,platform:"linux",floatingWindow:true,codexLinks:false};document.body.classList.add("floating-window");}
  State.settings.showIntegrationPills=true;
  State.settings.activeIntegrations=["integration_github","integration_vercel","integration_n8n","integration_notion"];
  for(const id of [...State.settings.activeIntegrations,"integration_clickup"]){State.integrations[id]={configured:true,loaded:true,error:null,lastSuccess:now,data:{}};}
  State.settings.clickupWorkspace="demo";State.settings.clickupList="demo";
  State.loadIntegrationTasks();
  State.integrations.integration_clickup.data.tasks=[
    {id:"1",name:"Review the release checklist and the very long title that should remain readable",status:"In progress",dueDate:now-86400_000,url:"https://app.clickup.com"},
    {id:"2",name:"Prepare the next small improvement",status:"To do",dueDate:now+86400_000,url:"https://app.clickup.com"},
    {id:"3",name:"Test keyboard navigation",status:"To do",dueDate:null,url:"https://app.clickup.com"},
  ];
  State.integrations.integration_github.data.notifications=[1,2,3].map(id=>({id:String(id),title:id===1 ? "Review requested: a deliberately long pull request title to test truncation":"You were mentioned in a discussion",repository:"coucou/desktop",reason:id===1?"review_requested":"mention",updatedAt:new Date(now).toISOString(),url:"https://github.com/notifications"}));
  if(view.includes("inbox")){
    State.recentAlerts=[];
    for(let i=0;i<12;i++)State.recordInbox({source:i%2 ? "integration_github":"integration_clickup",eventId:`preview-${i}`,taskId:"demo",kind:i%3 ? "update":"connection",title:i%2 ? "Review requested":"My next ClickUp task",message:"A useful update with enough detail to test wrapping and scrolling without crowding the island.",time:now-i*60_000,action:{kind:"url",url:"https://github.com/notifications"}});
  }
  State.setFocus(view.includes("github")?"integration_github":"integration_clickup");
  if(view.includes("file"))State.droppedFile={name:"Release-notes-with-a-very-long-name.txt",path:"/tmp/preview.txt",size:1200};
  island.applySettings();island.alert(view.includes("inbox")?"history":view.includes("file")?"choose":"overview");
  return true;
}
