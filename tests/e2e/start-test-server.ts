import {createApp} from '../../src/app.js';
if(process.env.NODE_ENV!=='test')throw Error('TEST_RUNTIME_REQUIRED');
const {app}=createApp({dbFilename:':memory:'});
await app.listen({port:Number(process.env.PORT??32001),host:'127.0.0.1'});
