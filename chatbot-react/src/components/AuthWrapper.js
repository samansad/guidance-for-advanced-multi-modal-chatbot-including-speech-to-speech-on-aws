import React, { useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import Chat from './Chat-edge';
import Sidebar from './Sidebar';

const AuthWrapper = () => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);

  return (
    <Authenticator>
      {({ signOut, user }) => (
        <div className="app-container">
          <Sidebar 
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          />
          <div className={`main-content ${isSidebarCollapsed ? 'collapsed' : ''}`}>
            <div className="header">
              <img src="/nissan-logo.png" alt="Nissan Logo" style={{ height: '60px', marginBottom: '0px' }} />
              <h1>Welcome to the Market Intelligence (MI)<br />Knowledge Quick Share Solution</h1>
              <button onClick={signOut}>Sign Out</button>
            </div>
            <Chat />
          </div>
        </div>
      )}
    </Authenticator>
  );
};

export default AuthWrapper;