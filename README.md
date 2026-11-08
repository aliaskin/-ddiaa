# Sistem Kupon

iddaa bülteninden her gün 3-4-5-6 gibi sistem kuponları oluşturan, telefona uygulama olarak eklenebilen web uygulaması (PWA).

## Ne yapar?

- **Kupon (varsayılan: yüksek oran modu):** Günün bütün maçlarının bütün bahis seçenekleri (MS, İY/MS, maç skoru, İY skoru, kaç farkla, yarı bahisleri, MS+Alt/Üst, MS+KG, korner, kart…) incelenir; oranı 5–30 arasındaki her seçeneğin gerçek olasılığı hesaplanır ve 6 maçlık **3-4-5-6 sistem, 2 misli = 84 TL** kupona en uygun 6 seçim konur. Hedef: belirlenen kazanca (varsayılan 10.000 TL) ulaşma olasılığını en yükseğe çıkarmak. Her sonucun (3, 4, 5, 6 tutma) olasılığı ve kazancı gösterilir, kupon 10.000 kez simüle edilir. Kral oranlar (iddaa.com'da taç işaretli olanlar) kullanılır. Ayarlardan otomatik sistem arama (bütçeye sığan en iyi sistem) ya da başka oran aralıkları seçilebilir.
- **Kurallar (varsayılan açık):** *Gol bekle* — Alt, KG Yok, 0-0, "0-1 gol" gibi ya da ancak az gollü maçta tutan seçimler alınmaz. *Sürpriz galibiyet yok* — kazanma ihtimali %22'nin altındaki takıma "kazanır" oynanmaz; favori maçı kazanıyorsa İY/MS 1/2 veya 2/1 serbest.
- **Günün simülasyonu:** Her maç, oranlar + takım istatistikleri (puan durumu, son 10 maç, attığı/yediği goller, ilk yarı golleri) ile kurulan gol modeliyle 10.000 kez oynatılır. Her seçimin kaç kez tuttuğu, maçın en sık skorları ve kuponun bu 10.000 günde ne kazandırdığı gösterilir.
- **Maçlar:** Bültendeki tüm futbol maçları, her maç için modelin olasılıkları, tüm oranlar, form, puan durumu, son 10 maç, aralarındaki maçlar ve iddaa istatistik notları.
- **10 Oran:** Toplam oranı hedefe (varsayılan 10) yakın 2, 3 ve 4 maçlık kombinasyonları, tutma olasılığına göre sıralar.
- **Geçmiş:** Oynadığın kuponları kaydeder, sonuçları otomatik kontrol eder, net kâr/zararı tutar.

## Nasıl hesaplıyor?

1. Bülten, her maçın tüm bahis seçenekleri (`/sportsbook/event/{id}`) ve oranlar `sportsbookv2.iddaa.com`, istatistikler `statisticsv2.iddaa.com` adresinden doğrudan telefondan çekilir (sunucu yok).
2. Her pazarın oranından kâr payı çıkarılır (power yöntemi), tüm pazarlara birlikte uyan Dixon-Coles düzeltmeli Poisson gol modeli kurulur.
3. İstatistik ağırlığı açıksa takımların puan durumu ve son maçlarından kurulan gol beklentisi, oranlardan gelen beklentiyi hafifçe düzeltir (olasılıklar doğrudan karıştırılmaz; bu, yüksek oranlarda sahte "değer" üretirdi). Gol dışı pazarlar (korner, kart) kendi oranlarından hesaplanır.
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

### Yüksek oran araştırması (`tests/high-odds-check.mjs`)

5–30 oranlı seçimlerde değer (oran × olasılık) en iyi MS+Alt/Üst, MS+KG ve skor bahislerinde çıkıyor (~0.85–0.90). İY/MS 1/2 ve 2/1'de iddaa'nın kâr payı en yüksek (ortalama ~0.59), bu yüzden ancak gerçekten en iyisiyse seçiliyor. Örnek gün: 6 maç 3-4-5-6, 2 misli kuponunda 3 tutarsa ~800–1.800 TL, 4 tutarsa ~10.000–19.000 TL; para alma olasılığı ~%2 (≈50 günde 1), 10.000 TL+ olasılığı ~%0.16 (≈600 günde 1).

Uyarı: iddaa'nın kâr payı yüksek olduğu için hiçbir kombinasyonun uzun vadeli beklenen dönüşü %100'ün üstünde değildir. Uygulama kazanç garanti etmez. 18 yaş altına yasaktır.

## Geliştirme

Derleme adımı yok; düz HTML/CSS/JS (ES modülleri).

```sh
python3 -m http.server 8000           # http://localhost:8000
node tests/live-check.mjs             # modeli canlı veriyle dener (proxy arkasında: NODE_USE_ENV_PROXY=1)
```

## Yayınlama (GitHub Pages)

Repo ayarlarında **Settings → Pages → Build and deployment → Deploy from a branch**, dal olarak bu dalı ve `/ (root)` klasörünü seç. Ücretsiz GitHub hesabında Pages yalnızca herkese açık (public) depolarda çalışır.
