/** Fixed pure renderer fixture, executed separately against original and patched IRMIA source. */
import {deriveRequest} from '../src/runtime/agent-loop.ts';
const request=deriveRequest({
  persona:{identity:'兼容性验证角色',constitution:'不越过工具授权边界',style:'简洁',state:'',personaHash:'fixture',relationship:null},
  tools:[{name:'speak',description:'发送简短消息',parameters:{type:'object',properties:{text:{type:'string'}}}}],
  timezone:'Asia/Shanghai',lane:'heavy',events:[],wakeEvent:null,
  taskCard:{title:'核对消息',turn:1,step:1,todoOpen:[]},
  now:'2026-10-29T10:00:00.000Z',model:'fixture',channelRender:null,
} as Parameters<typeof deriveRequest>[0]);
process.stdout.write(JSON.stringify({model:request.model,instructions:request.instructions,input:request.input,tools:request.tools}));
