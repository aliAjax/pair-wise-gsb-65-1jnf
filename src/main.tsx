import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { App } from './App'
import './styles.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#166a72', borderRadius: 4, fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif' } }}>
        <App />
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
