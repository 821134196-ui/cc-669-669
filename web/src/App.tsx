import { useState } from 'react';
import OpsView from './OpsView';
import CustomerView from './CustomerView';

export default function App() {
  const [tab, setTab] = useState<'ops' | 'customer'>('ops');
  return (
    <div className="app">
      <header>
        <h1>预订到货批次分配系统</h1>
        <nav>
          <button className={tab === 'ops' ? 'active' : ''} onClick={() => setTab('ops')}>
            运营台
          </button>
          <button className={tab === 'customer' ? 'active' : ''} onClick={() => setTab('customer')}>
            客户端
          </button>
        </nav>
      </header>
      <main>{tab === 'ops' ? <OpsView /> : <CustomerView />}</main>
    </div>
  );
}
