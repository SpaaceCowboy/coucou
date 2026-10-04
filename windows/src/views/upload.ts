// Drop zone, upload progress and the "what do you want to do with it" card —
// ports of UploadView / UploadingView / ChooseView from IslandViewContent.swift.
//
// Sending a file by email is not in the Windows v1, so `choose` offers the one
// action the spec asks for: ask a question about it.

import { h, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

/** Dashed rounded rect drawn as SVG so the dashes can march like on macOS. */
function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "20");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

export function buildUpload(): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title", text: "Drop one file here" });
  const tags = h(
    "div",
    { class: "drop-tags" },
    ...[["Images","PNG, JPEG, GIF and WebP. Claude: 5 MiB; Codex: 8 MiB."],["Text","UTF-8 text up to 200,000 bytes."],["Code","UTF-8 source files up to 200,000 bytes."],["PDF · Claude","PDFs require Claude; up to 23 MiB."]].map(([text,title]) => h("span", {text,title})),
  );
  const card = h(
    "div",
    { class: "card drop-card" },
    frame,
    h("div", { class: "drop-body" }, title, tags),
  );
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      card.classList.toggle("over", State.fileDragOver);
    },
  };
}

export function buildUploading(): ViewHost {
  const label = h("span", { class: "up-name" });
  const percent = h("span", { class: "up-pct" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  const card = h(
    "div",
    { class: "card up-card" },
    h("div", { class: "up-row" }, label, percent),
    h("div", { class: "up-track" }, fill, glow),
  );
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      const done = State.uploadProgress >= 0.999;
      const pct = Math.round(State.uploadProgress * 100);
      label.textContent = done
        ? `✓  ${State.droppedFile?.name ?? "File"}`
        : `Preparing ${State.droppedFile?.name ?? "file"}`;
      label.classList.toggle("done", done);
      percent.textContent = done ? "" : `${pct} %`;
      const w = State.uploadProgress * 526;
      fill.style.width = `${w}px`;
      glow.style.transform = `translateX(${Math.max(0, w - 14)}px)`;
      glow.style.opacity = State.uploadProgress > 0.01 ? "1" : "0";
      card.classList.toggle("done", done);
    },
  };
}

export function buildChoose(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title file-choice-title" });
  const sub = h("div", { class: "sub", text: "What do you want to do with it?" });
  const row = h(
    "div",
    { class: "actions" },
    h("button", {
      class: "btn primary",
      text: "Ask a question",
      onclick: () => actions.setView("prompt"),
    }),
    h("button", {
      class: "btn secondary",
      text: "Cancel",
      onclick: () => {State.droppedFile=null;State.promptContext=null;State.promptDraft="";actions.setView(State.defaultView());},
    }),
  );
  const language=h("input",{class:"translation-language",value:"English","aria-label":"Translate into",placeholder:"Translate into…"}) as HTMLInputElement;
  const shortcuts=[
    ["Summarize",()=>"Summarize the attached file briefly, highlighting its main points."],
    ["Explain",()=>"Explain the attached file in clear, simple language. Highlight anything important to understand."],
    ["Translate",()=>`Translate the attached file into ${language.value.trim() || "English"}. Preserve its meaning and structure.`],
  ] as const;
  const buttons=shortcuts.map(([label,prompt])=>h("button",{class:"btn secondary",text:label,onclick:()=>{State.promptDraft=prompt();actions.setView("prompt");}}));
  let checked="",checking=false,attachmentError="";
  row.prepend(...buttons);
  row.append(language);
  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title, sub, row),
    ),
  );

  return {
    el,
    sync() {
      const file=State.droppedFile;
      const checkKey=(file?.path ?? "")+State.settings.chatProvider;
      if(file && checkKey!==checked){
        checked=checkKey;checking=true;attachmentError="";
        void Bridge.attachmentCheck(file.path,State.settings.chatProvider).catch(error=>{if(checkKey===checked)attachmentError=String(error).replace(/^Error:\s*/,"");})
          .finally(()=>{if(checkKey===checked){checking=false;State.notify();}});
      }
      clear(title);
      title.append(
        h("b", { text: State.droppedFile?.name ?? "file",title:State.droppedFile?.name ?? "file" }),
        document.createTextNode(" is ready."),
      );
      const pdf=State.droppedFile?.name.toLowerCase().endsWith(".pdf");
      sub.textContent=attachmentError || (pdf && State.settings.chatProvider!=="claude" ? "PDFs need Claude. Switch provider in Settings → Chat." : "Choose a shortcut, then edit your prompt before sending.");
      for(const button of [...buttons,row.querySelector<HTMLButtonElement>(".primary")!])button.disabled=checking || !!attachmentError || (!!pdf && State.settings.chatProvider!=="claude");
    },
  };
}
