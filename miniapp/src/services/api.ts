import Taro from '@tarojs/taro'
import { CLOUDBASE_ENV_ID, CLOUDBASE_SERVICE } from '../shared/constants'
import { getAccessToken, getApiBaseUrl, setAccessToken } from './session'

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  data?: unknown
  params?: Record<string, string | number | boolean | undefined | null>
}

export class ApiError extends Error {
  status: number
  data: unknown

  constructor(status: number, message: string, data: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

interface AuthConfigResponse {
  dev_mode?: boolean
}

interface UserSyncResponse {
  access_token: string
}

let h5DevSessionPromise: Promise<boolean> | null = null

function buildQuery(params?: ApiOptions['params']): string {
  if (!params) return ''
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}

function getHeaders(): Record<string, string> {
  const token = getAccessToken()
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function getErrorDetail(data: unknown): string | undefined {
  const payload = data as { detail?: unknown; error?: { message?: string } } | undefined
  if (typeof payload?.detail === 'string') return payload.detail
  if (payload?.detail && typeof payload.detail === 'object' && 'message' in payload.detail) {
    return String((payload.detail as { message?: unknown }).message)
  }
  return payload?.error?.message
}

function isH5Runtime(): boolean {
  return Taro.getEnv() === Taro.ENV_TYPE.WEB
}

async function requestHttpRaw<T>(
  baseUrl: string,
  path: string,
  options: ApiOptions,
  headers: Record<string, string>,
): Promise<T> {
  let response
  try {
    response = await Taro.request({
      url: `${baseUrl}/api/v1${path}${buildQuery(options.params)}`,
      method: options.method || 'GET',
      data: options.data,
      header: headers,
    })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'Unable to connect to API server'
    throw new ApiError(0, message, null)
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ApiError(response.statusCode, getErrorDetail(response.data) || 'Request failed', response.data)
  }

  return response.data as T
}

async function ensureH5DevSession(baseUrl: string): Promise<boolean> {
  if (!isH5Runtime()) return false
  if (h5DevSessionPromise) return h5DevSessionPromise

  h5DevSessionPromise = (async () => {
    try {
      const config = await requestHttpRaw<AuthConfigResponse>(
        baseUrl,
        '/auth/config',
        { method: 'GET' },
        { 'Content-Type': 'application/json' },
      )
      if (!config.dev_mode) return false

      const response = await requestHttpRaw<UserSyncResponse>(
        baseUrl,
        '/auth/wechat-miniapp/sync',
        {
          method: 'POST',
          data: {
            openid: 'h5-dev-user',
            display_name: 'H5 Dev User',
          },
        },
        { 'Content-Type': 'application/json' },
      )
      setAccessToken(response.access_token)
      return true
    } catch {
      return false
    } finally {
      h5DevSessionPromise = null
    }
  })()

  return h5DevSessionPromise
}

function canUseCloudContainer(): boolean {
  const cloud = (Taro as unknown as { cloud?: { callContainer?: Function } }).cloud
  return Taro.getEnv() === Taro.ENV_TYPE.WEAPP && Boolean(CLOUDBASE_ENV_ID && CLOUDBASE_SERVICE && cloud?.callContainer)
}

async function requestViaCloudContainer<T>(path: string, options: ApiOptions): Promise<T> {
  const cloud = (Taro as unknown as {
    cloud?: {
      callContainer?: (options: {
        config: { env: string }
        path: string
        method: string
        header: Record<string, string>
        data?: unknown
        service: string
      }) => Promise<{ statusCode?: number; data?: unknown }>
    }
  }).cloud

  const response = await cloud!.callContainer!({
    config: { env: CLOUDBASE_ENV_ID },
    service: CLOUDBASE_SERVICE,
    path: `/api/v1${path}${buildQuery(options.params)}`,
    method: options.method || 'GET',
    header: getHeaders(),
    data: options.data,
  })

  const statusCode = response.statusCode || 200
  const data = response.data
  if (statusCode < 200 || statusCode >= 300) {
    const payload = data as { detail?: string } | undefined
    throw new ApiError(statusCode, payload?.detail || 'Request failed', data)
  }

  return data as T
}

async function requestViaHttp<T>(path: string, options: ApiOptions): Promise<T> {
  const baseUrl = getApiBaseUrl()
  if (!baseUrl) {
    throw new ApiError(400, 'API base URL is not configured', null)
  }

  if (!getAccessToken() && !path.startsWith('/auth/')) {
    await ensureH5DevSession(baseUrl)
  }

  try {
    return await requestHttpRaw<T>(baseUrl, path, options, getHeaders())
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && !path.startsWith('/auth/')) {
      const sessionReady = await ensureH5DevSession(baseUrl)
      if (sessionReady) {
        return requestHttpRaw<T>(baseUrl, path, options, getHeaders())
      }
    }
    throw error
  }
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (canUseCloudContainer()) {
    return requestViaCloudContainer<T>(path, options)
  }
  return requestViaHttp<T>(path, options)
}
