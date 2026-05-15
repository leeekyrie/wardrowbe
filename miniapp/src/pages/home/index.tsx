import React from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import './index.scss'
import PageHeader from '../../components/PageHeader'
import type { AnalyticsResponse, Outfit, UserProfile, WeatherData } from '../../shared/types'
import { formatTemp } from '../../shared/temperature'
import { getOutfits } from '../../services/outfits'
import { getAnalyticsSummary, getUserProfile, getWeather } from '../../services/user'

export default function HomePage() {
  const [profile, setProfile] = React.useState<UserProfile | null>(null)
  const [weather, setWeather] = React.useState<WeatherData | null>(null)
  const [analytics, setAnalytics] = React.useState<AnalyticsResponse | null>(null)
  const [pendingOutfits, setPendingOutfits] = React.useState<Outfit[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const nextProfile = await getUserProfile()
      setProfile(nextProfile)

      const [nextAnalytics, nextPending] = await Promise.all([
        getAnalyticsSummary().catch(() => null),
        getOutfits({ status: 'pending', page: 1, pageSize: 3 }).catch(() => ({ outfits: [], total: 0, page: 1, page_size: 3, has_more: false })),
      ])

      setAnalytics(nextAnalytics)
      setPendingOutfits(nextPending.outfits)

      if (nextProfile.location_lat && nextProfile.location_lon) {
        const nextWeather = await getWeather(nextProfile.location_lat, nextProfile.location_lon).catch(() => null)
        setWeather(nextWeather)
      } else {
        setWeather(null)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载首页失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useDidShow(() => {
    load()
  })

  const locationLabel = profile?.location_name || '上海'
  const weatherLabel = weather
    ? `${formatTemp(weather.temperature, 'celsius')} · ${weather.condition}`
    : '23C · 多云'
  const heroNote = weather
    ? `体感 ${formatTemp(weather.feels_like, 'celsius')}，外套可选薄款防风夹克`
    : '通勤温差偏小，外套可选薄款防风夹克'
  const insightItems = (analytics?.insights || []).slice(0, 3)

  return (
    <View className='page stack home-page'>
      <PageHeader
        eyebrow={profile?.display_name ? `欢迎回来，${profile.display_name}` : '欢迎回来'}
        title='今天穿什么'
        subtitle={`${locationLabel} ${weatherLabel} · 通勤模式`}
      />

      {error ? (
        <View className='section-card'>
          <Text>{error}</Text>
        </View>
      ) : null}
      {loading ? (
        <View className='section-card'>
          <Text>正在加载首页…</Text>
        </View>
      ) : null}

      <View className='home-page__hero'>
        <View className='stack home-page__hero-copy'>
          <Text className='home-page__hero-label'>今日建议</Text>
          <Text className='home-page__hero-title'>亚麻衬衫 + 深色直筒裤</Text>
          <Text className='home-page__hero-note'>{heroNote}</Text>
        </View>
        <View className='home-page__hero-look'>
          <View className='home-page__hanger' />
          <View className='home-page__shirt' />
          <View className='home-page__pants' />
        </View>
      </View>

      <View className='grid-2 home-page__actions-grid'>
        <View className='home-page__action-card home-page__action-card--primary' onClick={() => Taro.switchTab({ url: '/pages/suggest/index' })}>
          <Text className='home-page__action-title'>生成穿搭</Text>
          <Text className='home-page__action-subtitle'>一键匹配天气和场景</Text>
        </View>
        <View className='home-page__action-card' onClick={() => Taro.navigateTo({ url: '/pages/wardrobe/add' })}>
          <Text className='home-page__action-title'>添加单品</Text>
          <Text className='home-page__action-subtitle'>拍照录入衣橱</Text>
        </View>
      </View>

      <View className='section-card home-page__status-card'>
        <View>
          <Text className='home-page__status-value'>{pendingOutfits.length}</Text>
          <Text className='muted'>待反馈穿搭</Text>
        </View>
        <View>
          <Text className='home-page__status-value'>{analytics?.wardrobe.total_items ?? '—'}</Text>
          <Text className='muted'>衣橱单品</Text>
        </View>
      </View>

      <View className='section-card stack home-page__closet-strip'>
        <View className='row'>
          <Text className='section-title'>今日可选</Text>
          <Text className='muted' onClick={() => Taro.switchTab({ url: '/pages/wardrobe/index' })}>查看衣橱</Text>
        </View>
        <View className='home-page__garment-row'>
          <View className='home-page__garment home-page__garment--shirt'>
            <View className='home-page__garment-shirt-neck' />
            <View className='home-page__garment-shirt-body' />
          </View>
          <View className='home-page__garment home-page__garment--jacket'>
            <View className='home-page__garment-jacket-left' />
            <View className='home-page__garment-jacket-right' />
          </View>
          <View className='home-page__garment home-page__garment--pants'>
            <View className='home-page__garment-pants-left' />
            <View className='home-page__garment-pants-right' />
          </View>
          <View className='home-page__garment home-page__garment--shoe'>
            <View className='home-page__garment-shoe-upper' />
            <View className='home-page__garment-shoe-sole' />
          </View>
        </View>
      </View>

      <View className='section-card stack home-page__insights'>
        <Text className='section-title'>衣橱洞察</Text>
        {insightItems.length
          ? insightItems.map((insight, index) => (
              <View key={insight} className='home-page__insight-row'>
                <View className={`home-page__insight-dot home-page__insight-dot--${index + 1}`} />
                <Text className='home-page__insight-text'>{insight}</Text>
              </View>
            ))
          : (
              <>
                <View className='home-page__insight-row'>
                  <View className='home-page__insight-dot home-page__insight-dot--1' />
                  <Text className='home-page__insight-text'>3 件单品本周还没穿过</Text>
                </View>
                <View className='home-page__insight-row'>
                  <View className='home-page__insight-dot home-page__insight-dot--2' />
                  <Text className='home-page__insight-text'>黑白灰占比高，可补低饱和蓝</Text>
                </View>
                <View className='home-page__insight-row'>
                  <View className='home-page__insight-dot home-page__insight-dot--3' />
                  <Text className='home-page__insight-text'>周五有降温，提前准备叠穿</Text>
                </View>
              </>
            )}
      </View>
    </View>
  )
}
