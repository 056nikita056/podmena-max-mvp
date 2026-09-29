from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/podmena-presentation.pdf'
FONT = '/Users/nikitastepanov/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype/DejaVuSans.ttf'
BOLD = FONT.replace('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf')
pdfmetrics.registerFont(TTFont('DV', FONT))
pdfmetrics.registerFont(TTFont('DVB', BOLD))
W,H = 960,540
INK = HexColor('#18202C'); MUTED=HexColor('#667487'); BLUE=HexColor('#1769FF'); LINE=HexColor('#DBE3ED')
c = canvas.Canvas(str(OUT), pagesize=(W,H), pageCompression=1)
c.setTitle('Подмена — MVP для трека «Эффективный бизнес»')

def txt(x,y,s,size=16,bold=False,color=INK):
    c.setFillColor(color); c.setFont('DVB' if bold else 'DV',size); c.drawString(x,y,s)
def para(x,top,text,width,size=17,color=INK,leading=None,bold=False):
    style=ParagraphStyle('x',fontName='DVB' if bold else 'DV',fontSize=size,leading=leading or size*1.42,textColor=color)
    p=Paragraph(text,style); _,height=p.wrap(width,1000); p.drawOn(c,x,top-height); return height
def base(num,label,title,sub=None):
    c.setFillColor(HexColor('#FFFFFF')); c.rect(0,0,W,H,fill=1,stroke=0)
    txt(46,501,'ПОДМЕНА  /  ЭФФЕКТИВНЫЙ БИЗНЕС',10,True,BLUE)
    txt(46,449,title,31,True)
    if sub: para(46,432,sub,860,14,MUTED)
    c.setStrokeColor(LINE); c.line(46,42,914,42)
    txt(46,23,label.upper(),9,True,MUTED); txt(887,23,f'{num:02d} / 07',9,True,MUTED)
def line(x1,y1,x2,y2): c.setStrokeColor(LINE); c.setLineWidth(1); c.line(x1,y1,x2,y2)
def image(path,x,y,w,h,crop=None):
    im=Image.open(ROOT/path).convert('RGB')
    if crop: im=im.crop(crop)
    iw,ih=im.size; scale=min(w/iw,h/ih); nw,nh=iw*scale,ih*scale
    c.drawImage(ImageReader(im),x+(w-nw)/2,y+(h-nh)/2,width=nw,height=nh,mask='auto')

def page(): c.showPage()

base(1,'служебный слайд','Проверка MVP','Публичная версия. Секреты и доступы передаются жюри приватно.')
txt(46,346,'Работающее приложение в MAX',17,True); para(46,329,'Ожидается постоянный HTTPS-адрес и привязка к существующему боту.',790,15,MUTED)
txt(46,266,'Репозиторий и commit hash',17,True); para(46,249,'[ссылка на GitHub и проверенный commit hash после публикации]',790,15,MUTED)
txt(46,185,'API и вход',17,True); para(46,168,'[постоянный HTTPS API]. Для локальной проверки: docker compose up --build -d, затем включить ENABLE_BROWSER_DEMO=1.',830,15,MUTED)
para(46,96,'Путь: новая смена → поиск → отклик → сообщение → предложение → отдельное демо-подтверждение.',860,14,BLUE)
page()

base(2,'проблема и аудитория','Срочная замена в кофейне','Управляющий одной кофейни или небольшой сети в Москве ищет бариста на ближайшую смену.')
txt(46,336,'Сейчас',18,True); para(46,313,'Условия смены повторяются в разных чатах и сервисах. Ответы приходят отдельно. После выбора человека остаётся вопрос: согласился ли он на точные условия?',390,17)
txt(520,336,'В MVP',18,True,BLUE); para(520,313,'Одна заявка собирает место, время, оплату и навыки. Источники показывают свой статус, отклики сравниваются, переписка и подтверждение сохраняются.',390,17)
line(480,166,480,354)
para(46,115,'Гипотеза ценности: меньше ручной координации и яснее статус согласования. Интервью и измерения в реальных кофейнях пока не проводились.',850,15,MUTED)
page()

base(3,'процесс','От разрозненного поиска к одной заявке')
txt(46,358,'AS IS',12,True,MUTED); txt(503,358,'TO BE',12,True,BLUE)
for y,a,b in [(314,'Написать условия в несколько каналов','Создать заявку один раз'),(243,'Сверять отклики вручную','Увидеть подходящих людей и статус источников'),(172,'Уточнять согласие в переписке','Отдельно получить подтверждение условий')]:
    txt(46,y,a,16); txt(503,y,b,16); line(46,y-22,914,y-22)
para(46,93,'Продукт не гарантирует наличие работника и фактическую явку. Эти события отделены от согласия на смену.',860,15,MUTED)
page()

base(4,'основной сценарий','Результат виден по этапам','Фрагменты экранов из запущенного локального приложения на ширине 375 px.')
image('docs/screenshots/03-conversation-mobile.png',46,68,190,325,(0,680,375,1320))
image('docs/screenshots/04-confirmed-mobile.png',261,68,190,325,(0,270,375,910))
txt(498,356,'01  Поиск и отклик',16,True); para(498,341,'Сервер отбирает профили по роли, обязательным навыкам, ставке и известной доступности.',407,14,MUTED)
txt(498,275,'02  Диалог и предложение',16,True); para(498,260,'Сообщения сохраняются. Предложение фиксирует место, время и оплату; статус остаётся «Ожидаем подтверждения».',407,14,MUTED)
txt(498,178,'03  Подтверждение',16,True); para(498,163,'Отдельное модельное событие переводит заявку в «Подмена согласована». Затем управляющий отмечает выход.',407,14,MUTED)
page()

base(5,'реализация','Что действительно сделано','Модельные источники обозначены в каждом экране.')
txt(46,350,'Реально в продукте',18,True); para(46,324,'MAX UI и Bridge, серверный HTTP API, SQLite, заявки, переписка, состояния, резерв и история. Проверены локально в браузере и автоматическими тестами.',392,16)
txt(515,350,'Модельно',18,True,BLUE); para(515,324,'Десять вымышленных кандидатов. YouDo и Профи.ру представлены детерминированными адаптерами. Ответ и подтверждение кандидата запускает серверный симулятор.',395,16)
line(480,167,480,360)
para(46,111,'Не реализовано: реальные биржи, юридическое оформление, проверка документов, платежи. Работа внутри MAX зависит от токена, HTTPS-хостинга и привязки бота.',865,15,MUTED)
page()

base(6,'проверка эффекта','Как измерить пользу в пилоте')
for y,n,heading,desc in [(345,'01','Время до согласования','От создания заявки до отдельного подтверждения кандидата.'),(256,'02','Ручные действия','Сколько сообщений и переключений между каналами потребовалось управляющему.'),(167,'03','Надёжность выхода','Доля подтверждённых смен и доля невыходов после подтверждения.')]:
    txt(46,y,n,15,True,BLUE); txt(112,y,heading,18,True); para(112,y-17,desc,768,14,MUTED)
para(46,83,'Численных обещаний об экономии нет. Метрики требуют пилота на реальных сменах и сравнения с текущим процессом.',860,14,MUTED)
page()

base(7,'масштабирование и риски','Следующие шаги после MVP')
for y,n,heading,desc in [(355,'1','Другие кофейни','Перенести сценарий, настроить точки, навыки, резерв и часовой пояс.'),(274,'2','Другие сменные бизнесы','Адаптировать роли, требования и правила допуска к работе.'),(193,'3','Один внешний партнёр','Согласовать API, права на данные и обмен откликами; заменить модельный адаптер.')]:
    txt(46,y,n,18,True,BLUE); txt(90,y,heading,17,True); para(90,y-17,desc,790,13,MUTED)
para(46,105,'Источники: кейс «Эффективный бизнес», стр. 6–14, 16–19; dev.max.ru/docs/webapps и docs/chatbots. Интервью не проводились.',850,12,MUTED)
page()

c.save()
print(OUT)
