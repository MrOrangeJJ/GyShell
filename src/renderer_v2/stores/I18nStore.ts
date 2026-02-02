import { makeObservable, observable, action, computed } from 'mobx'
import { en } from '../translations/en'
import { zh } from '../translations/zh'

export type AppLocale = 'en' | 'zh-CN'
type Translations = typeof en

export class I18nStore {
  locale: AppLocale = 'en'

  constructor() {
    makeObservable(this, {
      locale: observable,
      setLocale: action,
      t: computed
    })
  }

  setLocale(locale: AppLocale) {
    this.locale = locale
  }

  get t(): Translations {
    return this.locale === 'zh-CN' ? zh : en
  }
}

