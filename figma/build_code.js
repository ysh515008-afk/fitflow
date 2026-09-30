/* ============================================================
   figma/build_code.js · 共享的 Figma 插件 code.js 生成器
   ------------------------------------------------------------
   把「节点树」（customer-management.screen.json 同形对象）与设计 token
   一起编译成自包含的 figma/plugin/code.js。

   被两处复用：
   - figma/gen_plugin.js（命令行：node figma/gen_plugin.js）
   - server/editor.mjs（网页编辑器「导出回 Figma」写回接口）
   保证两处产出完全一致。
   ============================================================ */

const TOKENS = {
  brand: '#0E8F5B', 'brand-2': '#0A6E46', 'brand-tint': '#E6F4EC', 'brand-tint-2': '#CFE9DB',
  ink: '#0F1A17', 'ink-2': '#39463F', 'ink-3': '#55635C', 'ink-4': '#6A7871',
  surface: '#FFFFFF', 'surface-2': '#F7FAF8', 'surface-3': '#F1F5F2',
  line: '#E2E9E4', 'line-2': '#EFF4F0',
  warn: '#9A5B00', 'warn-tint': '#FCF2E1', danger: '#B93B2C', 'danger-tint': '#FBECE9',
};

const BUILDER = `/*
 * FitFlow -> Figma 导入器（自包含插件）
 * 运行后会在当前页面生成「客户管理」设计稿。
 * 设计 token 与节点树来自 customer-management.screen.json（code -> figma 转换产物）。
 * 在 Figma 中：Plugins -> Development -> Import plugin from manifest，选中本目录的 manifest.json。
 */
const TOKENS = ${JSON.stringify(TOKENS)};
function rgb(hex){const h=(hex||'').replace('#','');if(h.length<6)return {r:0,g:0,b:0};return {r:parseInt(h.substr(0,2),16)/255,g:parseInt(h.substr(2,2),16)/255,b:parseInt(h.substr(4,2),16)/255};}
function paint(hex){if(!hex||hex==='transparent')return [];const c=rgb(hex);return [{type:'SOLID',color:{r:c.r,g:c.g,b:c.b},opacity:1}];}
function pick(weight){const n=Number(weight)||0;if(n>=700)return {family:'PingFang SC',style:'Bold'};if(n>=600)return {family:'PingFang SC',style:'Semibold'};if(n>=500)return {family:'PingFang SC',style:'Medium'};return {family:'PingFang SC',style:'Regular'};}
function resolve(c){return TOKENS[c]?TOKENS[c]:c;}

function buildNode(n){
  let node;
  if(n.type==='text'){
    node=figma.createText();
    try{node.fontName=pick(n.weight);}catch(e){}
    node.fontSize=n.size||13;
    node.characters=n.text||'';
    if(n.fill)node.fills=paint(resolve(n.fill));
    if(n.lineHeight)node.lineHeight={value:n.lineHeight,unit:'PIXELS'};
    node.name=n.name||'text';
    if(n.w)node.resize(n.w,node.height);
  } else if(n.type==='rect'){
    node=figma.createRectangle();
    node.resize(n.w||100,n.h||20);
    if(n.fill)node.fills=paint(resolve(n.fill));
    if(n.radius)node.cornerRadius=n.radius;
    if(n.stroke)node.strokes=paint(resolve(n.stroke));
    node.name=n.name||'rect';
  } else {
    node=figma.createFrame();
    if(n.fill)node.fills=paint(resolve(n.fill));else node.fills=[];
    if(n.radius)node.cornerRadius=n.radius;
    if(n.stroke)node.strokes=paint(resolve(n.stroke));
    if(n.w)node.resize(n.w,n.h||100);
    if(n.layout){const mode=n.layout==='H'?'HORIZONTAL':'VERTICAL';node.layoutMode=mode;node.primaryAxisSizingMode='AUTO';node.counterAxisSizingMode='AUTO';if(n.gap)node.itemSpacing=n.gap;if(n.pad!=null){node.paddingTop=n.pad;node.paddingBottom=n.pad;node.paddingLeft=n.pad;node.paddingRight=n.pad;}}
    if(n.clip)node.clipsContent=true;
    node.name=n.name||'frame';
  }
  if(n.children){for(const c of n.children){node.appendChild(buildNode(c));}}
  return node;
}

async function main(){
  try{
    const data = typeof SCREEN==='string' ? JSON.parse(SCREEN) : SCREEN;
    const fonts=[['PingFang SC','Regular'],['PingFang SC','Medium'],['PingFang SC','Semibold'],['PingFang SC','Bold'],['Inter','Regular']];
    for(const f of fonts){ try{ await figma.loadFontAsync({family:f[0],style:f[1]}); }catch(e){} }
    const root=buildNode(data.frame);
    root.name=data.screen||'FitFlow Screen';
    root.x=0;root.y=0;
    figma.currentPage.appendChild(root);
    figma.currentPage.selection=[root];
    figma.viewport.scrollAndZoomIntoView([root]);
    figma.notify('已导入：'+root.name);
  }catch(e){
    figma.notify('导入失败：'+(e&&e.message||e));
  }
  figma.closePlugin();
}
`;

/* 把节点树对象编译成完整的 code.js 文本 */
export function buildCodeJs(screenObj) {
  const screenJson = JSON.stringify(screenObj);
  return BUILDER + '\nconst SCREEN = ' + screenJson + ';\nmain();\n';
}

export { TOKENS };
