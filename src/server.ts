import { createApp } from './app.js';
const { app } = createApp();
app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).then(() => console.log('ERP Order Intelligence on http://localhost:3000'));
