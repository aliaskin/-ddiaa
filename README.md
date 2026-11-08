# Sistem Kupon

iddaa bülteninden her gün 3-4-5-6 gibi sistem kuponları oluşturan, telefona uygulama olarak eklenebilen web uygulaması (PWA).

## Ne yapar?

- **Kupon:** Günün maçlarından, seçtiğin sisteme (varsayılan 6 maç, 3-4-5-6, 2 misli = 42 kolon = 84 TL) en uygun 6 seçimi bulur. Her sonucun (3, 4, 5, 6 tutma) olasılığını ve kazancını, kâra geçme olasılığını ve beklenen dönüşü gösterir. Maçları kilitleyebilir, değiştirebilir, çıkarabilirsin.
- **Maçlar:** Bültendeki tüm futbol maçları, her maç için modelin olasılıkları, tüm oranlar, form, puan durumu, son 10 maç, aralarındaki maçlar ve iddaa istatistik notları.
- **10 Oran:** Toplam oranı hedefe (varsayılan 10) yakın 2, 3 ve 4 maçlık kombinasyonları, tutma olasılığına göre sıralar.
- **Geçmiş:** Oynadığın kuponları kaydeder, sonuçları otomatik kontrol eder, net kâr/zararı tutar.

## Nasıl hesaplıyor?

1. Bülten ve oranlar `sportsbookv2.iddaa.com`, istatistikler `statisticsv2.iddaa.com` adresinden doğrudan telefondan çekilir (sunucu yok).
2. Her pazarın oranından kâr payı çıkarılır (power yöntemi), tüm pazarlara birlikte uyan Dixon-Coles düzeltmeli Poisson gol modeli kurulur.
3. İstatistik ağırlığı açıksa takımların puan durumu ve son maçlarından ikinci bir gol modeli kurulup karıştırılır.
4. Sistem kuponu için 2ⁿ olası sonuç tek tek hesaplanır; MBS kuralına, maç başına tek seçime ve lig sınırına uyarak seçilen hedefe göre en iyi kombinasyon aranır.

Uyarı: iddaa'nın kâr payı yüksek olduğu için hiçbir kombinasyonun uzun vadeli beklenen dönüşü %100'ün üstünde değildir. Uygulama kazanç garanti etmez. 18 yaş altına yasaktır.

## Geliştirme

Derleme adımı yok; düz HTML/CSS/JS (ES modülleri).

```sh
python3 -m http.server 8000           # http://localhost:8000
node tests/live-check.mjs             # modeli canlı veriyle dener (proxy arkasında: NODE_USE_ENV_PROXY=1)
```

## Yayınlama (GitHub Pages)

Repo ayarlarında **Settings → Pages → Build and deployment → Deploy from a branch**, dal olarak bu dalı ve `/ (root)` klasörünü seç. Ücretsiz GitHub hesabında Pages yalnızca herkese açık (public) depolarda çalışır.
