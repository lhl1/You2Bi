import pytest

from backend.app.v1.speech_text import normalize_speech_text


@pytest.mark.parametrize(('original', 'spoken'), [
    ('共有 12 人，预算 1,205 元，编号 007。', '共有 十二 人，预算 一千二百零五 元，编号 零零七。'),
    ('2026年09月03日、2026-09-03', '二零二六年九月三日、二零二六年九月三日'),
    ('12:05：上升１２．５％，下降 -3‰，共 $3.50。', '十二点五分：上升百分之十二点五，下降 负千分之三，共 三点五零美元。'),
    ('1/3、5～10公里、10-20% 和 -5--2°C', '三分之一、五到十公里、百分之十到百分之二十 和 负五到负二摄氏度'),
    ('PS5、RTX 4090、USB 3.2、v1.7.4、1080p', 'PS 五、RTX 四零九零、USB 三点二、版本一点七点四、一零八零 P'),
    ('8GB、60fps、2.4-5GHz', '八吉字节、六十帧每秒、二点四到五吉赫兹'),
    ('2块 SSD、2台主机，第2台带 GPU。', '两块 固态硬盘、两台主机，第二台带 图形处理器。'),
    ('买了3，500人看过。', '买了三，五百人看过。'),
    ('链接 https://example.org/123?q=45，邮箱 x42@example.org，耗时 5 秒。',
     '链接 https://example.org/123?q=45，邮箱 x42@example.org，耗时 五 秒。'),
])
def test_chinese_spoken_forms(original, spoken):
    assert normalize_speech_text(original, 'zh-CN') == spoken


def test_non_chinese_output_stays_verbatim():
    assert normalize_speech_text('PS5, 60fps and 12.5%', 'en-US') == 'PS5, 60fps and 12.5%'
