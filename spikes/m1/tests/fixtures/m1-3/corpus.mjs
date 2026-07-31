const topics = [
  { id: "metering", exact: "Nikon F3HP", zh: "Nikon F3HP 的中央重点测光在逆光场景需要曝光补偿。", ja: "Nikon F3HP の中央重点測光は逆光で露出補正が必要です。", en: "The Nikon F3HP center-weighted meter needs exposure compensation in backlight." },
  { id: "lens", exact: "Planar 50mm", zh: "Planar 50mm 镜头以高微反差和自然焦外表现著称。", ja: "Planar 50mm レンズは高いマイクロコントラストと自然なボケで知られます。", en: "The Planar 50mm lens is known for microcontrast and natural bokeh." },
  { id: "film", exact: "Kodak Tri-X 400", zh: "Kodak Tri-X 400 黑白胶片适合纪实摄影并具有明显颗粒。", ja: "Kodak Tri-X 400 はドキュメンタリー写真向けで粒状感が特徴です。", en: "Kodak Tri-X 400 suits documentary photography and has pronounced grain." },
  { id: "developer", exact: "Kodak D-76", zh: "Kodak D-76 显影液提供平衡的颗粒、锐度和感光度。", ja: "Kodak D-76 現像液は粒状性、鮮鋭度、感度のバランスが良好です。", en: "Kodak D-76 developer balances grain, sharpness, and film speed." },
  { id: "aperture", zh: "缩小光圈会增加景深，但过小光圈可能受到衍射影响。", ja: "絞りを小さくすると被写界深度が増えますが、回折の影響も生じます。", en: "Stopping down increases depth of field but very small apertures introduce diffraction." },
  { id: "shutter", zh: "慢速快门可以表现运动模糊，手持拍摄需要注意相机抖动。", ja: "低速シャッターは動感を表現できますが、手持ちでは手ぶれに注意します。", en: "A slow shutter shows motion blur while handheld work risks camera shake." },
  { id: "flash", zh: "跳灯闪光通过天花板反射产生更柔和的照明。", ja: "バウンスフラッシュは天井反射を使って柔らかな光を作ります。", en: "Bounce flash reflects from a ceiling to create softer illumination." },
  { id: "tripod", zh: "稳固三脚架和延时快门可以减少长曝光振动。", ja: "頑丈な三脚とセルフタイマーは長時間露光の振動を減らします。", en: "A sturdy tripod and self-timer reduce vibration during long exposures." },
  { id: "macro", zh: "微距摄影增加放大倍率时，有效光圈会变小并减少景深。", ja: "マクロ撮影で倍率が上がると実効絞りが暗くなり、被写界深度も浅くなります。", en: "At higher macro magnification the effective aperture darkens and depth of field shrinks." },
  { id: "filter", zh: "黄色滤镜能在黑白摄影中适度加深蓝天并改善云层对比。", ja: "黄色フィルターは白黒写真で青空を適度に暗くし、雲のコントラストを高めます。", en: "A yellow filter moderately darkens blue skies and improves cloud contrast in monochrome work." },
  { id: "scanning", zh: "底片扫描应保留高光和阴影余量，再在后期设置黑白场。", ja: "ネガスキャンではハイライトとシャドウの余裕を残し、後処理で黒白点を設定します。", en: "Negative scanning should preserve highlight and shadow headroom before setting black and white points." },
  { id: "archive", zh: "无酸底片袋和稳定低湿环境有助于长期保存胶片档案。", ja: "無酸性ネガシートと安定した低湿度環境はフィルムの長期保存に役立ちます。", en: "Acid-free sleeves and stable low humidity support long-term film preservation." },
  { id: "panorama", zh: "全景接片应锁定曝光和白平衡，并保持足够重叠区域。", ja: "パノラマ合成では露出とホワイトバランスを固定し、十分な重なりを確保します。", en: "Panorama stitching needs locked exposure and white balance with sufficient overlap." },
  { id: "zone", zh: "区域曝光法把测光值映射到预期影调，并结合显影控制反差。", ja: "ゾーンシステムは測光値を意図する階調へ配置し、現像でコントラストを制御します。", en: "The zone system places meter readings into intended tones and controls contrast through development." },
  { id: "grain", zh: "高感光度胶片通常颗粒更明显，曝光不足还会降低阴影细节。", ja: "高感度フィルムは粒子が目立ちやすく、露出不足ではシャドウのディテールも失われます。", en: "High-speed film usually shows more grain, and underexposure also loses shadow detail." },
  { id: "contrast", zh: "柔和光线降低场景反差，适合保留高光与阴影层次。", ja: "柔らかな光はシーンのコントラストを下げ、明部と暗部の階調を残しやすくします。", en: "Soft light lowers scene contrast and helps preserve highlight and shadow gradation." },
  { id: "focal", zh: "长焦镜头压缩透视的说法实际来自更远拍摄距离，而非焦距本身。", ja: "望遠レンズの圧縮効果は焦点距離そのものではなく、遠い撮影距離によって生じます。", en: "Telephoto perspective compression comes from a longer camera distance, not focal length alone." },
  { id: "darkroom", zh: "暗房安全灯必须匹配相纸感色性，并控制距离和照射时间。", ja: "暗室のセーフライトは印画紙の感色性に合わせ、距離と照射時間を管理します。", en: "A darkroom safelight must match paper sensitivity with controlled distance and exposure time." },
  { id: "storage", zh: "相机长期存放前应取出电池，并避免高温高湿环境。", ja: "カメラを長期保管する前に電池を外し、高温多湿を避けます。", en: "Remove batteries before long-term camera storage and avoid heat and high humidity." },
  { id: "bokeh", zh: "焦外光斑形状受到光圈叶片数量、球差和机械遮挡影响。", ja: "ボケの形は絞り羽根の枚数、球面収差、機械的な遮光の影響を受けます。", en: "Bokeh shape is influenced by aperture blades, spherical aberration, and mechanical vignetting." },
];

const titles = {
  zh: (topic) => `中文摄影知识：${topic.id}`,
  ja: (topic) => `日本語写真ノート：${topic.id}`,
  en: (topic) => `English photography note: ${topic.id}`,
};

export const documents = topics.flatMap((topic) => ["zh", "ja", "en"].map((language) => ({
  id: `workspace-a-${language}-${topic.id}`,
  workspaceId: "workspace-a",
  language,
  title: titles[language](topic),
  body: topic[language],
})));

export const mirroredWorkspaceDocuments = documents.map((document) => ({
  ...document,
  id: document.id.replace("workspace-a", "workspace-b"),
  workspaceId: "workspace-b",
}));

const queryText = {
  zh: ["Nikon F3HP", "Planar 50mm", "Kodak Tri-X 400", "Kodak D-76", "缩小光圈增加景深", "慢速快门运动模糊", "跳灯闪光柔和照明", "三脚架减少长曝光振动", "底片扫描保留高光阴影", "黄色滤镜加深蓝天", "区域曝光法控制反差", "无酸底片袋长期保存"],
  ja: ["Nikon F3HP", "Planar 50mm", "Kodak Tri-X 400", "Kodak D-76", "絞りを小さく被写界深度", "低速シャッター動感", "バウンスフラッシュ柔らかな光", "三脚長時間露光振動", "ネガスキャンハイライトシャドウ", "黄色フィルター青空", "ゾーンシステムコントラスト", "無酸性ネガシート長期保存"],
  en: ["Nikon F3HP", "Planar 50mm", "Kodak Tri-X 400", "Kodak D-76", "stopping down depth of field", "slow shutter motion blur", "bounce flash softer illumination", "tripod long exposures vibration", "negative scanning highlight shadow", "yellow filter darkens blue skies", "zone system controls contrast", "acid-free sleeves long-term preservation"],
};
const queryTopics = ["metering", "lens", "film", "developer", "aperture", "shutter", "flash", "tripod", "scanning", "filter", "zone", "archive"];

export const queries = ["zh", "ja", "en"].flatMap((language) => queryText[language].map((text, index) => ({
  id: `${language}-q${String(index + 1).padStart(2, "0")}`,
  workspaceId: "workspace-a",
  language,
  query: text,
  kind: index < 4 ? "exact" : "theme",
  relevant: [`workspace-a-${language}-${queryTopics[index]}`],
})));
