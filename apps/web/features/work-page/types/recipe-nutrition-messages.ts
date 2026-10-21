import { defineMessages } from '../../../i18n/define.ts';

/** Recipe qualifications explain retained measurements without implying a health assessment. */
export const recipeNutritionMessages = defineMessages({
  en: { nutrient: 'Nutrient', amount: 'Amount', qualification: 'Basis, coverage and provenance',
    perServing: 'Per serving', wholeRecipe: 'Whole recipe', unnamedNutrient: 'Nutrient name not available',
    unnamedUnit: 'Unit name not available', substitutions: 'Author-declared substitutions', ingredientNotLoaded: 'Ingredient not loaded' },
  'zh-Hant': { nutrient: '營養素', amount: '含量', qualification: '計量基準、涵蓋範圍與來源',
    perServing: '每份', wholeRecipe: '整份食譜', unnamedNutrient: '營養素名稱無法取得',
    unnamedUnit: '單位名稱無法取得', substitutions: '作者聲明的替代食材', ingredientNotLoaded: '食材尚未載入' },
  'zh-Hans': { nutrient: '营养素', amount: '含量', qualification: '计量基准、涵盖范围与来源',
    perServing: '每份', wholeRecipe: '整份食谱', unnamedNutrient: '营养素名称不可用',
    unnamedUnit: '单位名称不可用', substitutions: '作者声明的替代食材', ingredientNotLoaded: '食材尚未加载' },
  ja: { nutrient: '栄養素', amount: '量', qualification: '算出基準・網羅性・出典',
    perServing: '1人分', wholeRecipe: 'レシピ全体', unnamedNutrient: '栄養素名を取得できません',
    unnamedUnit: '単位名を取得できません', substitutions: '作者による代替材料', ingredientNotLoaded: '材料が読み込まれていません' },
  ko: { nutrient: '영양소', amount: '양', qualification: '기준, 포함 범위 및 출처',
    perServing: '1인분당', wholeRecipe: '전체 레시피', unnamedNutrient: '영양소 이름을 사용할 수 없음',
    unnamedUnit: '단위 이름을 사용할 수 없음', substitutions: '작성자가 명시한 대체 재료', ingredientNotLoaded: '재료를 불러오지 않음' },
  de: { nutrient: 'Nährstoff', amount: 'Menge', qualification: 'Bezugsgröße, Abdeckung und Herkunft',
    perServing: 'Pro Portion', wholeRecipe: 'Gesamtes Rezept', unnamedNutrient: 'Nährstoffname nicht verfügbar',
    unnamedUnit: 'Einheitenname nicht verfügbar', substitutions: 'Vom Autor angegebene Alternativen', ingredientNotLoaded: 'Zutat nicht geladen' },
  fr: { nutrient: 'Nutriment', amount: 'Quantité', qualification: 'Base, couverture et provenance',
    perServing: 'Par portion', wholeRecipe: 'Recette entière', unnamedNutrient: 'Nom du nutriment indisponible',
    unnamedUnit: 'Nom de l’unité indisponible', substitutions: 'Substitutions indiquées par l’auteur', ingredientNotLoaded: 'Ingrédient non chargé' },
  es: { nutrient: 'Nutriente', amount: 'Cantidad', qualification: 'Base, cobertura y procedencia',
    perServing: 'Por ración', wholeRecipe: 'Receta completa', unnamedNutrient: 'Nombre del nutriente no disponible',
    unnamedUnit: 'Nombre de la unidad no disponible', substitutions: 'Sustituciones indicadas por el autor', ingredientNotLoaded: 'Ingrediente no cargado' },
});
