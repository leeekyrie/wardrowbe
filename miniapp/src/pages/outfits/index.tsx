import React from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Button, Input, Picker, ScrollView, Text, View } from '@tarojs/components'
import './index.scss'
import EmptyState from '../../components/EmptyState'
import OutfitCard from '../../components/OutfitCard'
import PageHeader from '../../components/PageHeader'
import { OUTFIT_FILTERS } from '../../shared/constants'
import { getOutfits } from '../../services/outfits'
import type { Outfit } from '../../shared/types'

function formatDateParam(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildMonthOptions() {
  const now = new Date()
  const options = [{ label: '全部月份', date_from: undefined as string | undefined, date_to: undefined as string | undefined }]

  for (let offset = 0; offset < 6; offset += 1) {
    const first = new Date(now.getFullYear(), now.getMonth() - offset, 1)
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
    options.push({
      label: `${first.getFullYear()}年${first.getMonth() + 1}月`,
      date_from: formatDateParam(first),
      date_to: formatDateParam(last),
    })
  }

  return options
}

const MONTH_OPTIONS = buildMonthOptions()

export default function OutfitsPage() {
  const [outfits, setOutfits] = React.useState<Outfit[]>([])
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  const [monthIndex, setMonthIndex] = React.useState(0)

  const load = React.useCallback(async () => {
    const params = filter === 'all'
      ? {}
      : filter === 'lookbook'
        ? { is_lookbook: true }
        : filter === 'accepted'
          ? { status: 'accepted' }
          : filter === 'pairing'
            ? { source: 'pairing' }
            : filter === 'replacement'
              ? { is_replacement: true }
              : { source: 'on_demand,scheduled' }

    const month = MONTH_OPTIONS[monthIndex]
    const response = await getOutfits({
      ...params,
      search,
      date_from: month.date_from,
      date_to: month.date_to,
      page: 1,
      pageSize: 20,
    })
    setOutfits(response.outfits)
  }, [filter, monthIndex, search])

  useDidShow(() => {
    load().catch((error) => Taro.showToast({ title: error instanceof Error ? error.message : '加载失败', icon: 'none' }))
  })

  return (
    <View className='page stack outfits-page'>
      <PageHeader
        eyebrow='穿搭记录'
        title='穿搭'
        subtitle='浏览、搜索并筛选历史穿搭'
      />

      <Input
        className='input'
        value={search}
        placeholder='搜索穿搭'
        onInput={(event) => setSearch(event.detail.value)}
        onConfirm={() => load()}
      />

      <ScrollView className='outfits-page__filters' scrollX enableFlex showScrollbar={false}>
        <View className='outfits-page__filters-inner'>
          {OUTFIT_FILTERS.map((option) => (
            <View
              key={option.value}
              className={`chip ${filter === option.value ? 'chip--active' : ''}`}
              onClick={() => setFilter(option.value)}
            >
              <Text>{option.label}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <Picker
        mode='selector'
        range={MONTH_OPTIONS.map((option) => option.label)}
        value={monthIndex}
        onChange={(event) => setMonthIndex(Number(event.detail.value))}
      >
        <View className='input outfits-page__month'>
          <Text>{MONTH_OPTIONS[monthIndex]?.label || MONTH_OPTIONS[0].label}</Text>
        </View>
      </Picker>

      {outfits.length
        ? outfits.map((outfit) => (
            <OutfitCard
              key={outfit.id}
              outfit={outfit}
              onClick={() => Taro.navigateTo({ url: `/pages/suggest/result?id=${outfit.id}` })}
            />
          ))
        : (
            <EmptyState
              title='还没有符合条件的穿搭'
              description='调整筛选条件，或者先去“穿搭建议”生成一套新的穿搭。'
              action={
                <Button className='primary-button' onClick={() => Taro.switchTab({ url: '/pages/suggest/index' })}>
                  去生成穿搭
                </Button>
              }
            />
          )}
    </View>
  )
}
