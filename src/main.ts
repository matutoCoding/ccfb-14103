// 入口

import { App } from './ui/app';
import { modelPage } from './ui/pages/modelPage';
import { sourcesPage } from './ui/pages/sourcesPage';
import { shieldingPage } from './ui/pages/shieldingPage';
import { doseviewPage } from './ui/pages/doseviewPage';
import { pathsPage } from './ui/pages/pathsPage';
import { alaraPage } from './ui/pages/alaraPage';

const app = new App();
app.registerPage('model', modelPage);
app.registerPage('sources', sourcesPage);
app.registerPage('shielding', shieldingPage);
app.registerPage('doseview', doseviewPage);
app.registerPage('paths', pathsPage);
app.registerPage('alara', alaraPage);

void app.start();

// 调试/脚本接口
(window as any).__app = app;
