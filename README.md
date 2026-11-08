# Sistem Kupon

iddaa bülteninden her gün 3-4-5-6 gibi sistem kuponları oluşturan, telefona uygulama olarak eklenebilen web uygulaması (PWA).

## Ne yapar?

- **Kupon:** Sadece yüksek oranlı seçimlerden (varsayılan 2.00–5.00) günün sistem kuponunu kurar. **Otomatik** modda bütçeye (varsayılan 84 TL) sığan tüm sistemleri (5–8 maç × 2'li/3'lü/… kolon kombinasyonları) dener, her biri için maçları optimize eder ve en iyisini seçer; diğerleri karşılaştırma tablosunda durur. Elle modda maç sayısı, sistem ve misliyi sen belirlersin. Maçları kilitleyebilir, değiştirebilir, çıkarabilirsin.
- **Maçlar:** Bültendeki tüm futbol maçları, her maç için modelin olasılıkları, tüm oranlar, form, puan durumu, son 10 maç, aralarındaki maçlar ve iddaa istatistik notları.
- **10 Oran:** Toplam oranı hedefe (varsayılan 10) yakın 2, 3 ve 4 maçlık kombinasyonları, tutma olasılığına göre sıralar.
- **Geçmiş:** Oynadığın kuponları kaydeder, sonuçları otomatik kontrol eder, net kâr/zararı tutar.

## Nasıl hesaplıyor?

1. Bülten ve oranlar `sportsbookv2.iddaa.com`, istatistikler `statisticsv2.iddaa.com` adresinden doğrudan telefondan çekilir (sunucu yok).
2. Her pazarın oranından kâr payı çıkarılır (power yöntemi), tüm pazarlara birlikte uyan Dixon-Coles düzeltmeli Poisson gol modeli kurulur.
3. İstatistik ağırlığı açıksa takımların puan durumu ve son maçlarından ikinci bir gol modeli kurulup karıştırılır.
4. Sistem kuponu için 2ⁿ olası sonuç tek tek hesaplanır; MBS kuralına, maç başına tek seçime ve lig sınırına uyarak seçilen hedefe göre en iyi kombinasyon aranır.
5. Otomatik sistem: bütçeye sığan her (maç sayısı × kolon boyutları) düzeni için seçimler optimize edilir, düzenler hedefe göre sıralanır.

### Sistem araştırması (`tests/system-research.mjs`)

Gerçek bültenle 2.00–5.00 oranlı seçimlerde, 84 TL bütçeyle bütün sistemler karşılaştırıldı. Bir kolondaki her maç kâr payını bir kez daha çarptığı için küçük kolonlar açık ara önde:

| Sistem | Bedel | Kâra geçme | 1 TL'ye beklenen dönüş |
|---|---|---|---|
| 5 maç 2'li (10 kolon × 8 misli) | 80 TL | %35 | 0.75 |
| 6 maç 2'li (15 × 5) | 75 TL | %30 | 0.72 |
| 6 maç 3'lü (20 × 4) | 80 TL | %22 | 0.64 |
| 6 maç 3-4-5-6 (42 × 2) | 84 TL | %20 | 0.58 |
| 6 maç 4-5-6 (22 × 3) | 66 TL | %12 | 0.51 |

2'li kolon için maçların MBS'si en fazla 2 olmalı; o gün yeterli maç yoksa arama 3'lü sistemlere iner.

Uyarı: iddaa'nın kâr payı yüksek olduğu için hiçbir kombinasyonun uzun vadeli beklenen dönüşü %100'ün üstünde değildir. Uygulama kazanç garanti etmez. 18 yaş altına yasaktır.

## Geliştirme

Derleme adımı yok; düz HTML/CSS/JS (ES modülleri).

```sh
python3 -m http.server 8000           # http://localhost:8000
node tests/live-check.mjs             # modeli canlı veriyle dener (proxy arkasında: NODE_USE_ENV_PROXY=1)
```

## Yayınlama (GitHub Pages)

Repo ayarlarında **Settings → Pages → Build and deployment → Deploy from a branch**, dal olarak bu dalı ve `/ (root)` klasörünü seç. Ücretsiz GitHub hesabında Pages yalnızca herkese açık (public) depolarda çalışır.
